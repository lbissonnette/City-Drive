// Per-clip prompts for the video worker.
//
// MiniMax H3 is trained on one prompt structure per input mode, published by
// MiniMax as the h3-prompt-writing skill:
//   https://github.com/MiniMax-AI/MiniMax-H3/blob/main/skills/h3-prompt-writing/references/base-en.txt
// Our clips are first+last-frame (FL2VA), so each prompt is:
//
//   How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with
//   the 0.00-second mark of the target video; Picture 2 (from Shot 1) aligns with the S.SS-second mark …
//
//   integrated_multimodal_description: [Shot 1] <style, first-frame anchor, camera motion,
//     the path between the frames, landing on Picture 2>
//
//   overall_soundscape: <ambient and physical sounds>
//
//   non_diegetic_music: N/A
//
// The alignment line and field names must stay verbatim. Camera moves use the
// guide's vocabulary (Push In, Pan Left/Right, POV) with optional amplitude
// ("with small/large amplitude") and speed ("at slow/fast speed"), written as
// a sentence rather than tags. H3 has no negative prompt; the negative prompt
// in the job doc is only used by the Wan 2.2 workflows.

const DEFAULT_DRIVE_DESCRIPTION =
  'The car drives steadily forward in its lane at an even city pace, so the buildings, trees, ' +
  'parked cars and street signs on both sides slide smoothly past while the road ahead keeps approaching.';

const DEFAULT_NEGATIVE_PROMPT =
  'static, frozen, camera shake, jump cut, blurry, distorted, warped buildings, text, watermark, people morphing';

const H3_SOUNDSCAPE =
  'A steady engine hum and the soft roll of tires on asphalt continue throughout, ' +
  'with light wind noise and other traffic passing in the distance.';

// Signed change in heading (degrees, clockwise positive) from one frame to the next.
function headingDelta(from, to) {
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  return ((to - from + 540) % 360) - 180;
}

// The camera sentence for a clip: always a forward push, plus a pan when the
// road turns between the two frames.
function cameraMotion(turn) {
  const deg = Math.abs(turn);
  if (deg < 15) {
    return 'The camera pushes in at a steady speed, keeping the road centered and the horizon level.';
  }
  const side = turn > 0 ? 'right' : 'left';
  const amplitude = deg < 45 ? ' with small amplitude' : deg > 100 ? ' with large amplitude' : '';
  const road = deg > 60 ? `the car turns ${side} with the road` : `the road bends to the ${side}`;
  return `The camera pushes in at a steady speed and pans ${side}${amplitude} as ${road}, keeping the horizon level.`;
}

function looksLikeH3Prompt(text) {
  return /integrated_multimodal_description:/.test(text);
}

// Full FL2VA prompt for one MiniMax H3 clip. A description that is already a
// complete H3 prompt is passed through untouched.
function h3ClipPrompt({ seconds, turn = 0, description = DEFAULT_DRIVE_DESCRIPTION }) {
  description = (description || DEFAULT_DRIVE_DESCRIPTION).trim();
  if (looksLikeH3Prompt(description)) return description;
  const end = seconds.toFixed(2);
  return [
    'How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the ' +
      `0.00-second mark of the target video; Picture 2 (from Shot 1) aligns with the ${end}-second mark of the target video.`,
    '',
    'integrated_multimodal_description: [Shot 1] Live-action, a forward-facing POV shot from the driver\'s seat ' +
      'begins on the street exactly as shown in Picture 1, preserving its buildings, road markings, parked cars, ' +
      `signage, weather and lighting. ${cameraMotion(turn)} ${description} ` +
      'The street gradually takes on the buildings, lighting and layout of Picture 2, the remaining differences ' +
      'narrow, and the shot settles into the position, framing and composition established by Picture 2 at the end of the shot.',
    '',
    `overall_soundscape: ${H3_SOUNDSCAPE}`,
    '',
    'non_diegetic_music: N/A',
  ].join('\n');
}

// Plain prompt for the Wan 2.2 fallback workflows, which take a short caption
// plus a negative prompt.
function wanClipPrompt({ turn = 0, description = DEFAULT_DRIVE_DESCRIPTION }) {
  const deg = Math.abs(turn);
  const bend = deg < 15 ? '' : ` The road ${deg > 60 ? 'turns' : 'bends'} ${turn > 0 ? 'right' : 'left'}.`;
  return `Dashcam footage from a car driving smoothly forward along the street, steady camera, realistic, ` +
    `natural lighting. ${(description || DEFAULT_DRIVE_DESCRIPTION).trim()}${bend}`;
}

function clipPrompt(workflow, opts) {
  return workflow.startsWith('minimax_h3') ? h3ClipPrompt(opts) : wanClipPrompt(opts);
}

module.exports = {
  DEFAULT_DRIVE_DESCRIPTION, DEFAULT_NEGATIVE_PROMPT, clipPrompt, headingDelta, h3ClipPrompt, wanClipPrompt,
};
