/**
 * Lightweight keyword-based sentiment tagger.
 * Converts message text → StateVector as a fallback when no explicit
 * @@emotion@@ markers are present. Ported from visage/old/brain.py.
 *
 * Maps keyword hits to emotion dimensions (joy, anger, thinking, etc.)
 * rather than raw valence/arousal, so the output plugs directly into
 * the EmotionDriver.
 */

import type { StateVector } from './emotion';

// --- Keyword lexicons: word → Record<emotion, weight> ---

type EmotionWeights = Record<string, number>;

interface LexiconEntry {
  emotions: EmotionWeights;
}

const LEXICON: Record<string, LexiconEntry> = {
  // Positive / joy
  good:       { emotions: { joy: 0.3, confidence: 0.2 } },
  great:      { emotions: { joy: 0.5, excitement: 0.2 } },
  excellent:  { emotions: { joy: 0.6, confidence: 0.3 } },
  perfect:    { emotions: { joy: 0.5, confidence: 0.4 } },
  love:       { emotions: { joy: 0.6, excitement: 0.2 } },
  happy:      { emotions: { joy: 0.6 } },
  wonderful:  { emotions: { joy: 0.5, excitement: 0.2 } },
  awesome:    { emotions: { joy: 0.5, excitement: 0.3 } },
  fantastic:  { emotions: { joy: 0.5, excitement: 0.4 } },
  nice:       { emotions: { joy: 0.3, calm: 0.2 } },
  thanks:     { emotions: { joy: 0.2, calm: 0.2 } },
  brilliant:  { emotions: { joy: 0.4, excitement: 0.3, confidence: 0.2 } },
  fun:        { emotions: { joy: 0.4, excitement: 0.3 } },
  exciting:   { emotions: { excitement: 0.6, joy: 0.3 } },
  cool:       { emotions: { joy: 0.3, confidence: 0.2 } },
  elegant:    { emotions: { joy: 0.3, calm: 0.2, confidence: 0.2 } },
  clever:     { emotions: { joy: 0.2, confidence: 0.3, thinking: 0.2 } },
  clean:      { emotions: { joy: 0.2, calm: 0.2, confidence: 0.2 } },
  solved:     { emotions: { joy: 0.4, confidence: 0.4 } },
  works:      { emotions: { joy: 0.3, confidence: 0.3 } },
  done:       { emotions: { joy: 0.3, calm: 0.2 } },
  exactly:    { emotions: { confidence: 0.4, joy: 0.2 } },
  yes:        { emotions: { joy: 0.2, confidence: 0.2 } },

  // Negative / anger / sadness
  error:      { emotions: { anger: 0.3, urgency: 0.3 } },
  fail:       { emotions: { sadness: 0.3, anger: 0.2 } },
  failed:     { emotions: { sadness: 0.4, anger: 0.2 } },
  bug:        { emotions: { anger: 0.3, urgency: 0.2 } },
  wrong:      { emotions: { anger: 0.2, uncertainty: 0.2 } },
  bad:        { emotions: { sadness: 0.3, anger: 0.2 } },
  broken:     { emotions: { anger: 0.4, urgency: 0.3 } },
  crash:      { emotions: { anger: 0.4, fear: 0.3, urgency: 0.4 } },
  problem:    { emotions: { anger: 0.2, thinking: 0.2, urgency: 0.2 } },
  issue:      { emotions: { thinking: 0.2, urgency: 0.2 } },
  unfortunately: { emotions: { sadness: 0.3 } },
  sorry:      { emotions: { sadness: 0.2 } },
  warning:    { emotions: { urgency: 0.3, fear: 0.2 } },
  stuck:      { emotions: { sadness: 0.2, anger: 0.2, thinking: 0.2 } },
  confused:   { emotions: { uncertainty: 0.4, thinking: 0.2 } },
  terrible:   { emotions: { anger: 0.4, sadness: 0.3 } },
  awful:      { emotions: { anger: 0.4, sadness: 0.3, disgust: 0.2 } },
  ugly:       { emotions: { disgust: 0.3, sadness: 0.2 } },
  mess:       { emotions: { anger: 0.3, disgust: 0.2 } },
  hack:       { emotions: { disgust: 0.2, uncertainty: 0.2 } },

  // Thinking / cognitive
  hmm:        { emotions: { thinking: 0.4 } },
  perhaps:    { emotions: { thinking: 0.3, uncertainty: 0.2 } },
  maybe:      { emotions: { uncertainty: 0.3, thinking: 0.2 } },
  analyzing:  { emotions: { thinking: 0.5 } },
  investigating: { emotions: { thinking: 0.4 } },
  looking:    { emotions: { thinking: 0.3 } },
  checking:   { emotions: { thinking: 0.3 } },
  consider:   { emotions: { thinking: 0.4, calm: 0.2 } },
  wondering:  { emotions: { thinking: 0.3, uncertainty: 0.2 } },

  // Surprise
  wow:        { emotions: { surprise: 0.6, joy: 0.3 } },
  whoa:       { emotions: { surprise: 0.5 } },
  interesting: { emotions: { surprise: 0.3, thinking: 0.3 } },
  unexpected: { emotions: { surprise: 0.5 } },
  wait:       { emotions: { surprise: 0.3, thinking: 0.2 } },
  oh:         { emotions: { surprise: 0.3 } },
  really:     { emotions: { surprise: 0.3 } },

  // Calm / confidence
  sure:       { emotions: { confidence: 0.3, calm: 0.2 } },
  absolutely: { emotions: { confidence: 0.5, joy: 0.2 } },
  definitely: { emotions: { confidence: 0.4 } },
  agreed:     { emotions: { confidence: 0.3, calm: 0.2 } },
  solid:      { emotions: { confidence: 0.4, calm: 0.2 } },

  // Urgency
  urgent:     { emotions: { urgency: 0.6 } },
  asap:       { emotions: { urgency: 0.5 } },
  critical:   { emotions: { urgency: 0.5, fear: 0.2 } },
  immediately: { emotions: { urgency: 0.5 } },
};

// Punctuation patterns
const EXCLAMATION_EMOTIONS: EmotionWeights = { excitement: 0.2, surprise: 0.15 };
const QUESTION_EMOTIONS: EmotionWeights = { thinking: 0.15, uncertainty: 0.1 };

/**
 * Analyze message text and return a StateVector.
 * Returns null if no meaningful signal is found.
 */
export function analyzeSentiment(text: string): StateVector | null {
  const lower = text.toLowerCase();
  const words = lower.match(/[a-z']+/g) || [];
  const accumulator: Record<string, number> = {};
  let totalWeight = 0;

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const entry = LEXICON[word];
    if (!entry) continue;

    // Weight recent words higher (exponential recency)
    const recency = Math.exp(-0.03 * (words.length - i));

    for (const [emotion, weight] of Object.entries(entry.emotions)) {
      accumulator[emotion] = (accumulator[emotion] || 0) + weight * recency;
    }
    totalWeight += recency;
  }

  // Punctuation signals
  const exclamations = (text.match(/!/g) || []).length;
  if (exclamations > 0) {
    const strength = Math.min(1, exclamations * 0.5);
    for (const [emotion, weight] of Object.entries(EXCLAMATION_EMOTIONS)) {
      accumulator[emotion] = (accumulator[emotion] || 0) + weight * strength;
    }
    totalWeight += strength;
  }

  const questions = (text.match(/\?/g) || []).length;
  if (questions > 0) {
    const strength = Math.min(1, questions * 0.5);
    for (const [emotion, weight] of Object.entries(QUESTION_EMOTIONS)) {
      accumulator[emotion] = (accumulator[emotion] || 0) + weight * strength;
    }
    totalWeight += strength;
  }

  // No signal
  if (totalWeight < 0.1) return null;

  // Normalize: scale so the max dimension is ~0.6 (subtle, not overwhelming)
  const maxVal = Math.max(...Object.values(accumulator));
  if (maxVal < 0.05) return null;

  const scale = Math.min(0.6 / maxVal, 1.0);
  const result: StateVector = {};

  for (const [emotion, value] of Object.entries(accumulator)) {
    const scaled = value * scale;
    if (scaled > 0.05) {
      result[emotion] = Math.min(1.0, scaled);
    }
  }

  return Object.keys(result).length > 0 ? result : null;
}
