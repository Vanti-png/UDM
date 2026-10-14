import { memo, useEffect, useEffectEvent, useRef, type RefObject } from 'react';

import { outputPosition, type Cut } from '@/lib/editor/segments';

/*
 * The added sound, heard while the picture plays.
 *
 * It follows the picture rather than keeping time of its own. The picture is
 * what the page drives -- played, paused, scrubbed, stepped over every piece
 * that was thrown away -- and the sound is the result's, so it stands wherever
 * the picture's position lands in the result: the kept seconds ahead of it.
 * Because a jump over a dropped piece lands on the same place in the result, a
 * join plays straight through, exactly as the export will.
 *
 * Nothing here is drawn. An `<audio>` of its own rather than a second track on
 * the video, because a video element plays only the sound in its own file.
 */

/**
 * How far the sound may wander from the picture while both play before it is
 * put back. Each correction is a seek, and a seek is heard; two elements left
 * alone drift by a few milliseconds a minute, so this is only ever met by a
 * jump.
 */
const DRIFT_SEC = 0.15;

/** `HAVE_FUTURE_DATA`: below it the picture is stalled, whatever `paused` says. */
const PLAYABLE = 3;

interface SoundPreviewProps {
  src: string;
  /** The page's picture, which this follows. */
  videoRef: RefObject<HTMLVideoElement | null>;
  /** The clip whose element `videoRef` holds: another clip is another element. */
  clipId: string;
  cuts: Cut[];
  /** Linear gain, as the export applies it. The preview stops at 100 %. */
  volume: number;
}

export const SoundPreview = memo(function SoundPreview({
  src,
  videoRef,
  clipId,
  cuts,
  volume,
}: SoundPreviewProps) {
  const audioRef = useRef<HTMLAudioElement>(null);

  // Read with the cuts as they are now: a piece deleted mid-play moves where
  // everything after it lands.
  const follow = useEffectEvent((video: HTMLVideoElement, audio: HTMLAudioElement) => {
    const at = outputPosition(cuts, video.currentTime);
    const past = Number.isFinite(audio.duration) && at >= audio.duration;
    if (video.paused || video.readyState < PLAYABLE || past) {
      if (!audio.paused) audio.pause();
      // Held exactly where the picture is, so the next press of play starts
      // both together.
      if (!past && Math.abs(audio.currentTime - at) > 0.01) audio.currentTime = at;
      return;
    }
    if (Math.abs(audio.currentTime - at) > DRIFT_SEC) audio.currentTime = at;
    if (audio.paused) void audio.play().catch(() => {});
  });

  useEffect(() => {
    const video = videoRef.current;
    const audio = audioRef.current;
    if (!video || !audio) return;
    const sync = () => follow(video, audio);
    // M mutes the picture for the preview alone, and the sound goes with it.
    const mute = () => {
      audio.muted = video.muted;
    };
    mute();
    sync();
    const events = ['play', 'playing', 'pause', 'ended', 'seeked', 'timeupdate', 'waiting'];
    for (const name of events) video.addEventListener(name, sync);
    video.addEventListener('volumechange', mute);
    return () => {
      for (const name of events) video.removeEventListener(name, sync);
      video.removeEventListener('volumechange', mute);
      audio.pause();
    };
  }, [clipId, src, videoRef]);

  useEffect(() => {
    const audio = audioRef.current;
    if (audio) audio.volume = Math.min(Math.max(volume, 0), 1);
  }, [volume, src]);

  return <audio ref={audioRef} src={src} preload="auto" hidden />;
});
