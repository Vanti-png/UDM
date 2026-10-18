//! Anime episodes from their licensors' own YouTube channels, filed as a series.
//!
//! The channels named here post whole episodes with the original Japanese
//! track and the subtitles as tracks of their own. An episode downloaded from
//! one of them is named the way media servers file a series:
//! `Series/Season 01/Series - S01E03.mp4`.

use once_cell::sync::Lazy;
use regex::Regex;

use crate::model::MediaMetadata;

/// The channels whose episodes are filed as a series, by id, with the name
/// they upload under.
const CHANNELS: &[(&str, &str)] = &[
    ("UC6pGDc4bFGD1_36IKv3FnYg", "Crunchyroll"),
    ("UCsj_CYajUSQ2ca8bYCMan9g", "It's Anime powered by REMOW"),
];

/// Where an episode sits in its series, read from its title.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Episode {
    pub series: String,
    pub season: u32,
    pub number: u32,
}

static EPISODE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)\b(?:episode|ep\.?)\s*#?\s*(\d{1,4})\b").expect("episode pattern is valid")
});

static SEASON: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)\bseason\s*(\d{1,2})\b").expect("season pattern is valid"));

/// "My Dress-Up Darling Episode 3 SUB/DUB | Then Why Don't We?" is episode 3
/// of the first season of "My Dress-Up Darling". A title that numbers no
/// episode -- a whole season in one video, a clip -- is not one.
pub fn parse_episode(title: &str) -> Option<Episode> {
    let episode = EPISODE.captures(title)?;
    let number: u32 = episode.get(1)?.as_str().parse().ok()?;
    let episode_at = episode.get(0)?.start();

    let season = SEASON.captures(title);
    let season_number = season
        .as_ref()
        .and_then(|found| found.get(1)?.as_str().parse().ok())
        .unwrap_or(1);
    // The series is what comes before the first of the two.
    let cut = season
        .and_then(|found| found.get(0).map(|whole| whole.start()))
        .filter(|start| *start < episode_at)
        .unwrap_or(episode_at);
    let series = title[..cut]
        .trim()
        .trim_end_matches(['-', '|', ':', '–', '—', ','])
        .trim();
    if series.is_empty() || number == 0 {
        return None;
    }
    Some(Episode {
        series: series.to_string(),
        season: season_number,
        number,
    })
}

/// The episode a download is, when it comes from one of the channels above.
pub fn episode_of(metadata: &MediaMetadata) -> Option<Episode> {
    let creator = metadata.creator.as_deref()?;
    CHANNELS
        .iter()
        .any(|(_, name)| *name == creator)
        .then(|| parse_episode(&metadata.title))
        .flatten()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_episode_is_read_from_its_title() {
        assert_eq!(
            parse_episode("My Dress-Up Darling Episode 3 SUB/DUB | Then Why Don't We?"),
            Some(Episode { series: "My Dress-Up Darling".into(), season: 1, number: 3 })
        );
        assert_eq!(
            parse_episode("Kaiju No. 8 Season 2 Episode 1 | English Sub"),
            Some(Episode { series: "Kaiju No. 8".into(), season: 2, number: 1 })
        );
        assert_eq!(
            parse_episode("VINLAND SAGA Episode 1 | Somewhere not here"),
            Some(Episode { series: "VINLAND SAGA".into(), season: 1, number: 1 })
        );
        assert_eq!(parse_episode("TOUGEN ANKI: Season 1 Complete (2025) | 6 Audio | MULTI-SUB"), None);
        assert_eq!(parse_episode("Gojo Locks In | My Dress-Up Darling Season 2"), None);
        assert_eq!(parse_episode("Episode 4"), None, "a number is not a series");
    }

    #[test]
    fn only_those_channels_name_their_downloads_as_episodes() {
        let metadata = |creator: &str| MediaMetadata {
            creator: Some(creator.into()),
            title: "VINLAND SAGA Episode 1 | Somewhere not here".into(),
            ..crate::providers::tests_support::blank()
        };
        assert_eq!(episode_of(&metadata("Crunchyroll")).map(|episode| episode.number), Some(1));
        assert_eq!(episode_of(&metadata("Someone Else")), None);
    }
}
