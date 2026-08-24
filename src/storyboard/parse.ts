/**
 * Parses osu! storyboards — a standalone `.osb`, or the `[Events]` section of a `.osu`
 * (maps often carry both; the caller merges them, see `parseStoryboard`).
 *
 * Format notes that drive the implementation, all confirmed against real `.osb` files:
 *  - Event and command names come in a word form and a numeric form (`Sprite` / `4`), and
 *    layer/origin likewise (`Background` / `0`). Both are accepted.
 *  - Commands are indented one level under their sprite; loop and trigger bodies are
 *    indented two. Both space and underscore count as indentation, and files mix them.
 *  - An empty end time means "same as start" (`C,0,13346,,0,0,0`), and omitted end values
 *    mean "same as start values" (`S,0,43188,,0.47`). Both are extremely common.
 *  - A command may carry more than two value groups as shorthand for consecutive tweens of
 *    equal duration; expanded here into separate commands.
 *  - Paths are Windows-style (`sb\scene1\x.png`) while `.osz` entries use forward slashes.
 */

import {
  COMMAND_ARITY, SbLayer, SbOrigin,
  type SbAnimation, type SbAnimationLoop, type SbCommand, type SbDrawable, type SbParam,
  type SbSample, type SbSprite, type SbTweenType, type Storyboard,
} from './types.js';

const LAYER_BY_NAME: Readonly<Record<string, SbLayer>> = {
  background: SbLayer.Background,
  fail: SbLayer.Fail,
  pass: SbLayer.Pass,
  foreground: SbLayer.Foreground,
  overlay: SbLayer.Overlay,
  '0': SbLayer.Background,
  '1': SbLayer.Fail,
  '2': SbLayer.Pass,
  '3': SbLayer.Foreground,
  '4': SbLayer.Overlay,
};

const ORIGIN_BY_NAME: Readonly<Record<string, SbOrigin>> = {
  topleft: SbOrigin.TopLeft,
  centre: SbOrigin.Centre,
  center: SbOrigin.Centre,
  centreleft: SbOrigin.CentreLeft,
  centerleft: SbOrigin.CentreLeft,
  topright: SbOrigin.TopRight,
  bottomcentre: SbOrigin.BottomCentre,
  bottomcenter: SbOrigin.BottomCentre,
  topcentre: SbOrigin.TopCentre,
  topcenter: SbOrigin.TopCentre,
  custom: SbOrigin.Custom,
  centreright: SbOrigin.CentreRight,
  centerright: SbOrigin.CentreRight,
  bottomleft: SbOrigin.BottomLeft,
  bottomright: SbOrigin.BottomRight,
  '0': SbOrigin.TopLeft,
  '1': SbOrigin.Centre,
  '2': SbOrigin.CentreLeft,
  '3': SbOrigin.TopRight,
  '4': SbOrigin.BottomCentre,
  '5': SbOrigin.TopCentre,
  '6': SbOrigin.Custom,
  '7': SbOrigin.CentreRight,
  '8': SbOrigin.BottomLeft,
  '9': SbOrigin.BottomRight,
};

const TWEEN_TYPES = new Set<string>(Object.keys(COMMAND_ARITY));

/** Strips the quotes osu! puts around paths — they are optional, so handle both. */
function unquote(raw: string): string {
  const s = raw.trim();
  return s.startsWith('"') && s.endsWith('"') && s.length >= 2 ? s.slice(1, -1) : s;
}

/** `.osz` entries use `/`; storyboards write `\`. Lowercased so lookups are case-insensitive. */
export function normalisePath(path: string): string {
  // Regex rather than replaceAll: the project targets ES2020.
  return path.replace(/\\/g, '/').toLowerCase();
}

/**
 * `walk1_.png` frame 3 → `walk1_3.png`. osu! inserts the index before the extension; a
 * path with no extension gets the index appended.
 */
function framePath(path: string, index: number): string {
  const dot = path.lastIndexOf('.');
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  if (dot <= slash) return normalisePath(`${path}${index}`);
  return normalisePath(`${path.slice(0, dot)}${index}${path.slice(dot)}`);
}

function num(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  if (trimmed === '') return fallback;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : fallback;
}

/** Indentation depth in leading spaces/underscores; both are valid and files mix them. */
function indentDepth(line: string): number {
  let depth = 0;
  while (depth < line.length) {
    const ch = line[depth];
    if (ch !== ' ' && ch !== '_') break;
    depth++;
  }
  return depth;
}

/**
 * Parses one command line into zero or more commands. Returns an empty array for lines the
 * format does not cover, so callers can record a warning and carry on.
 *
 * Loop and trigger headers return a single command with an empty body; the caller fills it
 * from the following, more deeply indented lines.
 */
function parseCommand(parts: readonly string[]): SbCommand[] {
  const type = (parts[0] ?? '').trim();

  if (type === 'L') {
    // L,<startTime>,<loopCount>
    return [{
      kind: 'loop',
      startTime: num(parts[1], 0),
      // A zero/absent count still plays the body once in osu!; clamp so evaluation is simple.
      loopCount: Math.max(1, Math.trunc(num(parts[2], 1))),
      commands: [],
    }];
  }

  if (type === 'T') {
    // T,<triggerName>,<startTime>,<endTime>[,<group>]
    return [{
      kind: 'trigger',
      trigger: (parts[1] ?? '').trim(),
      startTime: num(parts[2], 0),
      endTime: num(parts[3], num(parts[2], 0)),
      group: Math.trunc(num(parts[4], 0)),
      commands: [],
    }];
  }

  const easing = Math.trunc(num(parts[1], 0));
  const startTime = num(parts[2], 0);
  // Empty end time means an instant command: `C,0,13346,,0,0,0`.
  const endTime = num(parts[3], startTime);

  if (type === 'P') {
    const param = (parts[4] ?? '').trim().toUpperCase();
    if (param !== 'H' && param !== 'V' && param !== 'A') return [];
    return [{ kind: 'param', easing, startTime, endTime, param: param as SbParam }];
  }

  if (!TWEEN_TYPES.has(type)) return [];
  const tweenType = type as SbTweenType;
  const arity = COMMAND_ARITY[tweenType];

  const values = parts.slice(4).map(raw => num(raw, Number.NaN));
  // Trailing blanks are common; drop anything that failed to parse at the tail.
  while (values.length > 0 && Number.isNaN(values[values.length - 1])) values.pop();
  if (values.length < arity || values.some(Number.isNaN)) return [];

  const groups: number[][] = [];
  for (let i = 0; i + arity <= values.length; i += arity) groups.push(values.slice(i, i + arity));
  if (groups.length === 0) return [];

  // One group: the value is held (start === end). Two: a single tween. More: shorthand for
  // consecutive tweens of equal duration, each starting where the previous ended.
  if (groups.length === 1) {
    return [{ kind: 'tween', type: tweenType, easing, startTime, endTime, start: groups[0]!, end: groups[0]! }];
  }

  const duration = endTime - startTime;
  const out: SbCommand[] = [];
  for (let i = 0; i + 1 < groups.length; i++) {
    const from = startTime + duration * i;
    out.push({
      kind: 'tween',
      type: tweenType,
      easing,
      startTime: from,
      endTime: from + duration,
      start: groups[i]!,
      end: groups[i + 1]!,
    });
  }
  return out;
}

/** Absolute end time of a command, with loop repetitions expanded. */
function commandEnd(command: SbCommand): number {
  switch (command.kind) {
    case 'tween':
    case 'param':
      return command.endTime;
    case 'trigger':
      return command.endTime;
    case 'loop': {
      let bodyEnd = 0;
      for (const child of command.commands) bodyEnd = Math.max(bodyEnd, commandEnd(child));
      return command.startTime + bodyEnd * command.loopCount;
    }
  }
}

/** Absolute start time of a command; loop/trigger bodies are relative to their header. */
function commandStart(command: SbCommand): number {
  switch (command.kind) {
    case 'tween':
    case 'param':
      return command.startTime;
    case 'trigger':
      return command.startTime;
    case 'loop': {
      let bodyStart = Infinity;
      for (const child of command.commands) bodyStart = Math.min(bodyStart, commandStart(child));
      return command.startTime + (Number.isFinite(bodyStart) ? bodyStart : 0);
    }
  }
}

function spanOf(commands: readonly SbCommand[]): { startTime: number; endTime: number } {
  let startTime = Infinity;
  let endTime = -Infinity;
  for (const command of commands) {
    startTime = Math.min(startTime, commandStart(command));
    endTime = Math.max(endTime, commandEnd(command));
  }
  return { startTime, endTime };
}

/** Mutable builder for a drawable while its command lines are still being consumed. */
interface PendingDrawable {
  kind: 'sprite' | 'animation';
  layer: SbLayer;
  origin: SbOrigin;
  path: string;
  x: number;
  y: number;
  frameCount: number;
  frameDelay: number;
  loopType: SbAnimationLoop;
  commands: SbCommand[];
}

function finishDrawable(pending: PendingDrawable): SbDrawable {
  const { startTime, endTime } = spanOf(pending.commands);
  const base = {
    layer: pending.layer,
    origin: pending.origin,
    path: pending.path,
    lookupPath: normalisePath(pending.path),
    x: pending.x,
    y: pending.y,
    commands: pending.commands,
    startTime,
    endTime,
  };
  if (pending.kind === 'sprite') return { kind: 'sprite', ...base } satisfies SbSprite;
  const framePaths: string[] = [];
  for (let i = 0; i < pending.frameCount; i++) framePaths.push(framePath(pending.path, i));
  return {
    kind: 'animation',
    ...base,
    frameCount: pending.frameCount,
    frameDelay: pending.frameDelay,
    loopType: pending.loopType,
    framePaths,
  } satisfies SbAnimation;
}

/**
 * Parses storyboard text — a whole `.osb`, or a `.osu` (only its `[Events]` section is
 * read). Both are the same grammar; a `.osu` just wraps it in sections.
 */
export function parseStoryboardText(text: string): Storyboard {
  const drawables: SbDrawable[] = [];
  const samples: SbSample[] = [];
  const warnings: string[] = [];
  let backgroundPath: string | null = null;
  let videoPath: string | null = null;

  // A `.osb` has no [Events] header in some files, so start enabled and let a section
  // header switch us off; a `.osu` turns us on when [Events] appears.
  let inEvents = true;
  let sawSectionHeader = false;

  let pending: PendingDrawable | null = null;
  // Innermost open loop/trigger, so depth-2 lines attach to its body rather than the sprite.
  let openBlock: { commands: SbCommand[] } | null = null;

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const depth = indentDepth(raw);
    const body = raw.slice(depth).trim();
    if (body === '' || body.startsWith('//')) continue;
    // A .osu opens with `osu file format vN`, before any section header. Since parsing starts
    // enabled (for .osb files that omit [Events]), that line would otherwise be read as a
    // malformed event and warned about on every map that has an inline storyboard.
    if (/^osu file format v\d+/i.test(body)) continue;

    if (body.startsWith('[') && body.endsWith(']')) {
      // Flush first: a section header ends the open sprite, and in a .osu the last sprite
      // of [Events] is immediately followed by [TimingPoints]/[HitObjects] — clearing
      // without flushing silently dropped it.
      if (pending !== null) drawables.push(finishDrawable(pending));
      sawSectionHeader = true;
      inEvents = body.toLowerCase() === '[events]';
      pending = null;
      openBlock = null;
      continue;
    }
    if (sawSectionHeader && !inEvents) continue;

    const parts = body.split(',');
    const head = (parts[0] ?? '').trim();

    if (depth > 0) {
      if (pending === null) {
        warnings.push(`line ${i + 1}: command with no preceding sprite: ${body}`);
        continue;
      }
      const parsed = parseCommand(parts);
      if (parsed.length === 0) {
        warnings.push(`line ${i + 1}: unrecognised command: ${body}`);
        continue;
      }
      // Depth 1 closes any open loop/trigger and attaches to the sprite; deeper lines go
      // into the open block. Files are not always consistent about using exactly 2, so key
      // off "deeper than 1" rather than "=== 2".
      const target = depth > 1 && openBlock !== null ? openBlock.commands : pending.commands;
      if (depth <= 1) openBlock = null;
      for (const command of parsed) {
        target.push(command);
        if (command.kind === 'loop' || command.kind === 'trigger') {
          // Only a depth-1 header opens a block; nested loops are not part of the format.
          if (depth <= 1) openBlock = command as { commands: SbCommand[] } & SbCommand;
        }
      }
      continue;
    }

    // Depth 0 — a new event. Whatever sprite was open is done.
    if (pending !== null) {
      drawables.push(finishDrawable(pending));
      pending = null;
    }
    openBlock = null;

    if (head === '0' || head.toLowerCase() === 'background') {
      // 0,0,"bg.jpg"[,xOffset,yOffset]
      if (parts.length >= 3) backgroundPath = unquote(parts[2]!);
      continue;
    }
    if (head === '1' || head.toLowerCase() === 'video') {
      if (parts.length >= 3) videoPath = unquote(parts[2]!);
      continue;
    }
    if (head === '2' || head.toLowerCase() === 'break') continue;      // BeatmapParser's job
    if (head === '3') continue;                                        // legacy background colour

    if (head === '5' || head.toLowerCase() === 'sample') {
      // Sample,<time>,<layer>,"<path>"[,<volume>]
      const path = unquote(parts[3] ?? '');
      if (path === '') {
        warnings.push(`line ${i + 1}: sample with no path: ${body}`);
        continue;
      }
      samples.push({
        time: num(parts[1], 0),
        layer: LAYER_BY_NAME[(parts[2] ?? '').trim().toLowerCase()] ?? SbLayer.Background,
        path,
        lookupPath: normalisePath(path),
        volume: num(parts[4], 100),
      });
      continue;
    }

    const isSprite = head === '4' || head.toLowerCase() === 'sprite';
    const isAnimation = head === '6' || head.toLowerCase() === 'animation';
    if (!isSprite && !isAnimation) {
      warnings.push(`line ${i + 1}: unrecognised event: ${body}`);
      continue;
    }

    // Sprite,<layer>,<origin>,"<path>",<x>,<y>
    // Animation,<layer>,<origin>,"<path>",<x>,<y>,<frameCount>,<frameDelay>[,<loopType>]
    const path = unquote(parts[3] ?? '');
    if (path === '') {
      warnings.push(`line ${i + 1}: ${head} with no path: ${body}`);
      continue;
    }
    const layerKey = (parts[1] ?? '').trim().toLowerCase();
    const originKey = (parts[2] ?? '').trim().toLowerCase();
    if (!(layerKey in LAYER_BY_NAME)) warnings.push(`line ${i + 1}: unknown layer "${parts[1]}"`);
    if (!(originKey in ORIGIN_BY_NAME)) warnings.push(`line ${i + 1}: unknown origin "${parts[2]}"`);

    pending = {
      kind: isAnimation ? 'animation' : 'sprite',
      layer: LAYER_BY_NAME[layerKey] ?? SbLayer.Background,
      origin: ORIGIN_BY_NAME[originKey] ?? SbOrigin.TopLeft,
      path,
      x: num(parts[4], 320),
      y: num(parts[5], 240),
      // Animations need at least one frame to draw anything.
      frameCount: isAnimation ? Math.max(1, Math.trunc(num(parts[6], 1))) : 1,
      frameDelay: isAnimation ? num(parts[7], 0) : 0,
      loopType: (parts[8] ?? '').trim() === 'LoopOnce' ? 'LoopOnce' : 'LoopForever',
      commands: [],
    };
  }

  if (pending !== null) drawables.push(finishDrawable(pending));

  return {
    drawables,
    samples,
    backgroundPath,
    videoPath,
    hasContent: drawables.length > 0 || samples.length > 0,
    warnings,
  };
}

/**
 * Merges a map's two storyboard sources. osu! draws both: the `.osb` is shared across a
 * set's difficulties, while a `.osu`'s own `[Events]` adds difficulty-specific objects on
 * top — so the `.osu`'s drawables sort after the `.osb`'s within the same layer.
 *
 * Either argument may be omitted.
 */
export function parseStoryboard(osbText?: string | null, osuText?: string | null): Storyboard {
  const osb = osbText != null && osbText !== '' ? parseStoryboardText(osbText) : null;
  const osu = osuText != null && osuText !== '' ? parseStoryboardText(osuText) : null;
  if (osb === null) return osu ?? parseStoryboardText('');
  if (osu === null) return osb;

  const drawables = [...osb.drawables, ...osu.drawables];
  const samples = [...osb.samples, ...osu.samples];
  return {
    drawables,
    samples,
    // The .osu's own background/video wins: it is the difficulty-specific statement.
    backgroundPath: osu.backgroundPath ?? osb.backgroundPath,
    videoPath: osu.videoPath ?? osb.videoPath,
    hasContent: drawables.length > 0 || samples.length > 0,
    warnings: [...osb.warnings.map(w => `osb: ${w}`), ...osu.warnings.map(w => `osu: ${w}`)],
  };
}
