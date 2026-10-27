//! Bandwidth limiting.
//!
//! One token bucket shared by every native transfer, so "500 KB/s" in Settings
//! means 500 KB/s for the whole app, however many downloads and connections are
//! running. A connection asks for the bytes it has just received before it
//! writes them; when the bucket is in debt the caller sleeps until its share has
//! been paid back.
//!
//! Debt rather than refusal is deliberate. A chunk has already arrived by the
//! time it is counted, so refusing it would mean nothing; charging it and
//! sleeping makes the reader stop pulling from the socket, which is what slows
//! the server down. Callers queue on the debt in arrival order, so N
//! connections split the limit evenly without any of them being starved.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;

/// How much unused allowance may build up while nothing is downloading. Half a
/// second's worth lets a new connection start at full pace without letting an
/// idle minute turn into a minute-long burst.
const BURST_SEC: f64 = 0.5;

/// A wait is slept in steps no longer than this. Between them the caller looks
/// again: a limit raised or switched off in Settings, or a transfer paused or
/// cancelled, ends the wait within one step rather than after a debt run up
/// under the old figure has been slept off.
const MAX_WAIT: Duration = Duration::from_millis(500);

#[derive(Debug)]
pub struct RateLimiter {
    /// Bytes per second; zero is no limit.
    limit_bps: AtomicU64,
    bucket: Mutex<Bucket>,
}

#[derive(Debug)]
struct Bucket {
    /// Positive is allowance in hand, negative is debt.
    tokens: f64,
    refilled: Instant,
}

impl Bucket {
    /// Charge `bytes` at `limit_bps` as of `now`, and say how long the caller
    /// has to wait before that much would have been allowed.
    ///
    /// The debt is kept in full, however large. It is what makes connections
    /// queue: each one waits for every share charged before its own, so the
    /// total stays at the limit however many there are. A limit changed
    /// meanwhile starts the bucket over (`set_limit_bps`), and a wait ends
    /// early when its transfer stops (`acquire`), so a long debt never holds
    /// anything up that no longer needs to wait.
    fn charge(&mut self, now: Instant, bytes: u64, limit_bps: u64) -> Duration {
        let rate = limit_bps as f64;
        let elapsed = now.saturating_duration_since(self.refilled).as_secs_f64();
        self.refilled = now;
        self.tokens = (self.tokens + elapsed * rate).min(rate * BURST_SEC);
        self.tokens -= bytes as f64;

        if self.tokens >= 0.0 {
            Duration::ZERO
        } else {
            Duration::from_secs_f64(-self.tokens / rate)
        }
    }
}

impl Default for RateLimiter {
    fn default() -> Self {
        Self::new(0)
    }
}

impl RateLimiter {
    pub fn new(limit_bps: u64) -> Self {
        Self {
            limit_bps: AtomicU64::new(limit_bps),
            bucket: Mutex::new(Bucket {
                tokens: 0.0,
                refilled: Instant::now(),
            }),
        }
    }

    /// Settings speak in kilobytes a second; zero switches the limit off.
    pub fn set_kbps(&self, kbps: u64) {
        self.set_limit_bps(kbps.saturating_mul(1024));
    }

    pub fn set_limit_bps(&self, limit_bps: u64) {
        let previous = self.limit_bps.swap(limit_bps, Ordering::AcqRel);
        if previous != limit_bps {
            // Allowance or debt counted at the old rate means nothing at the new.
            if let Ok(mut bucket) = self.bucket.lock() {
                bucket.tokens = 0.0;
                bucket.refilled = Instant::now();
            }
        }
    }

    pub fn limit_bps(&self) -> u64 {
        self.limit_bps.load(Ordering::Acquire)
    }

    /// Account for `bytes` just received, sleeping while the limit says so.
    ///
    /// `stopped` is asked between steps of the wait: a transfer paused or
    /// cancelled meanwhile goes on to notice that at once, instead of sitting
    /// out its place in the queue first.
    pub async fn acquire(&self, bytes: u64, stopped: impl Fn() -> bool) {
        let limit = self.limit_bps();
        if limit == 0 || bytes == 0 {
            return;
        }
        let wait = match self.bucket.lock() {
            Ok(mut bucket) => bucket.charge(Instant::now(), bytes, limit),
            Err(_) => return,
        };
        let mut remaining = wait;
        while !remaining.is_zero() {
            let step = remaining.min(MAX_WAIT);
            tokio::time::sleep(step).await;
            remaining -= step;
            // Switched off, or changed, while this caller slept; or the
            // transfer it is pacing is over.
            if self.limit_bps() != limit || stopped() {
                return;
            }
        }
    }
}

static GLOBAL: Lazy<RateLimiter> = Lazy::new(RateLimiter::default);

/// The limiter every native transfer shares.
pub fn global() -> &'static RateLimiter {
    &GLOBAL
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bucket(at: Instant) -> Bucket {
        Bucket {
            tokens: 0.0,
            refilled: at,
        }
    }

    #[test]
    fn a_charge_over_the_allowance_waits_for_the_difference() {
        let start = Instant::now();
        let mut bucket = bucket(start);
        // 1000 B/s, nothing saved up: 500 bytes cost half a second.
        let wait = bucket.charge(start, 500, 1000);
        assert!((wait.as_secs_f64() - 0.5).abs() < 1e-6, "{wait:?}");
    }

    #[test]
    fn time_spent_waiting_pays_the_debt_back() {
        let start = Instant::now();
        let mut bucket = bucket(start);
        bucket.charge(start, 1000, 1000);
        // A second later the debt is gone and the next charge waits only for
        // itself.
        let wait = bucket.charge(start + Duration::from_secs(1), 250, 1000);
        assert!((wait.as_secs_f64() - 0.25).abs() < 1e-6, "{wait:?}");
    }

    #[test]
    fn concurrent_callers_queue_behind_each_other() {
        let start = Instant::now();
        let mut bucket = bucket(start);
        let first = bucket.charge(start, 1000, 1000);
        let second = bucket.charge(start, 1000, 1000);
        assert!(second > first, "the second waits for the first's share too");
        assert!((second.as_secs_f64() - 2.0).abs() < 1e-6, "{second:?}");
    }

    #[test]
    fn many_connections_still_add_up_to_the_limit() {
        // Eight connections each bring in 64 KiB at once under a 100 KiB/s
        // cap. All of it is paid for: the last in line waits for every share
        // before its own. Forgiving the debt past a couple of seconds let
        // eight connections through at more than twice the cap.
        let start = Instant::now();
        let mut bucket = bucket(start);
        let rate = 100 * 1024;
        let waits: Vec<Duration> = (0..8).map(|_| bucket.charge(start, 64 * 1024, rate)).collect();
        let last = waits.last().unwrap().as_secs_f64();
        assert!((last - 8.0 * 64.0 / 100.0).abs() < 1e-6, "{last}");
    }

    #[test]
    fn an_idle_spell_saves_up_only_a_short_burst() {
        let start = Instant::now();
        let mut bucket = bucket(start);
        // An hour idle is worth half a second at most.
        let later = start + Duration::from_secs(3600);
        assert_eq!(bucket.charge(later, 500, 1000), Duration::ZERO);
        let wait = bucket.charge(later, 500, 1000);
        assert!((wait.as_secs_f64() - 0.5).abs() < 1e-6, "{wait:?}");
    }

    #[tokio::test]
    async fn a_long_wait_ends_when_its_transfer_stops() {
        // Ten seconds of debt at 1000 B/s, for a transfer paused a moment in.
        let limiter = RateLimiter::new(1000);
        let started = std::time::Instant::now();
        limiter
            .acquire(10_000, || started.elapsed() >= Duration::from_millis(100))
            .await;
        assert!(started.elapsed() < Duration::from_secs(2), "{:?}", started.elapsed());
    }

    #[tokio::test]
    async fn a_long_wait_ends_when_the_limit_is_switched_off() {
        let limiter = std::sync::Arc::new(RateLimiter::new(1000));
        let switcher = std::sync::Arc::clone(&limiter);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            switcher.set_kbps(0);
        });
        let started = std::time::Instant::now();
        limiter.acquire(10_000, || false).await;
        assert!(started.elapsed() < Duration::from_secs(2), "{:?}", started.elapsed());
    }

    #[test]
    fn kilobytes_are_binary_kilobytes() {
        let limiter = RateLimiter::default();
        limiter.set_kbps(500);
        assert_eq!(limiter.limit_bps(), 512_000);
        limiter.set_kbps(0);
        assert_eq!(limiter.limit_bps(), 0);
    }

    #[tokio::test]
    async fn no_limit_never_waits() {
        let limiter = RateLimiter::default();
        let started = Instant::now();
        limiter.acquire(u64::MAX / 2, || false).await;
        assert!(started.elapsed() < Duration::from_millis(50));
    }
}
