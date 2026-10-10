// Prompt + multimodal part builders for every job type.

export const ASPECT_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];

export function closestAspectRatio(width, height) {
  if (!width || !height) return undefined;
  const target = Math.log(width / height);
  let best = ASPECT_RATIOS[0];
  let bestDiff = Infinity;
  for (const r of ASPECT_RATIOS) {
    const [w, h] = r.split(':').map(Number);
    const diff = Math.abs(Math.log(w / h) - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = r;
    }
  }
  return best;
}

export function resolveAspectRatio(option, width, height) {
  if (!option || option === 'auto') return closestAspectRatio(width, height);
  if (option === 'model') return undefined;
  return ASPECT_RATIOS.includes(option) ? option : closestAspectRatio(width, height);
}

const GENDER_EN = { female: 'female', male: 'male', other: '' };
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const MAX_INPUT_IMAGES = 14;

const POSITION_EN = {
  left: 'the person on the LEFT side of the photo',
  center: 'the person in the CENTER of the photo',
  right: 'the person on the RIGHT side of the photo',
  front: 'the person closest to the camera (foreground)',
  back: 'the person farther from the camera (background)',
};

const pct = (v) => `${Math.round(v * 100)}%`;

function horizontalWord(box) {
  const cx = box.x + box.w / 2;
  if (cx < 0.4) return 'left';
  if (cx > 0.6) return 'right';
  return 'center';
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function describeSubjectLocation(subject, index, subjects, hasGuide) {
  const bits = [];
  if (subject.box) {
    const boxed = subjects.filter((s) => s.box).sort((a, b) => (a.box.x + a.box.w / 2) - (b.box.x + b.box.w / 2));
    const order = boxed.indexOf(subject) + 1;
    let s = hasGuide ? `the person inside the box labeled "${index + 1}" on the POSITION GUIDE image` : 'the person';
    s += ` (${horizontalWord(subject.box)} part of the frame, approx. x ${pct(subject.box.x)}–${pct(subject.box.x + subject.box.w)}, y ${pct(subject.box.y)}–${pct(subject.box.y + subject.box.h)}`;
    if (boxed.length > 1) s += `; ${ordinal(order)} marked person from the left`;
    s += ')';
    bits.push(s);
  } else if (POSITION_EN[subject.position]) {
    bits.push(POSITION_EN[subject.position]);
  } else if (subjects.length === 1) {
    bits.push('the main person in the photo');
  }
  if (subject.desc) bits.push(`described by the user as: "${subject.desc}"`);
  if (!bits.length) bits.push(`person #${index + 1} in the photo`);
  return bits.join(', ');
}

function inlinePart(image) {
  return { inlineData: { mimeType: image.mime, data: image.buffer.toString('base64') } };
}

function labeledParts(images, text) {
  const parts = [];
  images.forEach((img, i) => {
    parts.push({ text: `Image ${i + 1} — ${img.label}:` });
    parts.push(inlinePart(img.image));
  });
  parts.push({ text });
  return parts;
}

const imgList = (nums) => (nums.length === 1 ? `Image ${nums[0]}` : `Images ${nums.join(', ')}`);

// Pulls the "HAIR: ..." line out of an AI-written appearance sheet.
function appearanceLine(appearance, key) {
  const m = new RegExp(`^\\s*${key}\\s*:\\s*(.+)$`, 'im').exec(appearance || '');
  return m ? m[1].trim() : '';
}

const STYLE_TEXT = {
  character: 'Match the art style of the CHARACTER REFERENCE images (line weight, coloring, cel shading, eye and hair rendering). If the references use different styles, unify everything into one consistent 2D style.',
  anime: 'High-budget modern TV anime style: clean line art, crisp cel shading, vivid colors — it should look like a screenshot from a high-quality anime.',
  webtoon: 'Full-color Korean webtoon (manhwa) style: clean digital line art, soft gradient shading, polished glossy coloring.',
  manga: 'Japanese manga illustration style with clean ink line art and soft digital coloring, like a full-color manga cover illustration.',
};

// legacy jobs stored a boolean noProps instead of the extras list
const LEGACY_NO_PROPS = 'Do not add bags, weapons or handheld props from the character references unless the person in Image 1 is actually holding something there.';

/**
 * Builds the parts for a "real photo -> 2D characters" job.
 * loadImage(rel) -> {mime, buffer}; getCharacter(id) -> character|null
 */
export function buildTransformParts(job, { loadImage, getCharacter }) {
  const opt = job.options || {};
  const subjects = job.subjects || [];
  if (!subjects.length) throw new Error('변환할 인물이 지정되지 않았습니다.');

  const hasGuide = Boolean(job.guideFile);
  const images = [];
  const addImage = (label, rel) => {
    images.push({ label, image: loadImage(rel) });
    return images.length;
  };

  addImage('SOURCE PHOTO (pose & composition only — ignore the real people\'s faces and hair)', job.sourceFile);
  if (hasGuide) addImage('POSITION GUIDE', job.guideFile);

  // one entry per distinct character, references deduplicated
  const charSlots = new Map();
  for (const s of subjects) {
    if (charSlots.has(s.characterId)) continue;
    const c = getCharacter(s.characterId);
    if (!c) throw new Error(`캐릭터를 찾을 수 없습니다 (${s.characterName || s.characterId}). 라이브러리에서 삭제되었을 수 있습니다.`);
    if (!c.images?.length) throw new Error(`캐릭터 "${c.name}"에 참조 이미지가 없습니다.`);
    charSlots.set(s.characterId, { character: c, letter: LETTERS[charSlots.size] || String(charSlots.size + 1), imageNumbers: [] });
  }

  // share the remaining image budget fairly between characters
  const budget = MAX_INPUT_IMAGES - images.length;
  const perChar = Math.max(1, Math.floor(budget / Math.max(1, charSlots.size)));
  for (const slot of charSlots.values()) {
    const refs = slot.character.images.slice(0, Math.min(perChar, Number(opt.maxRefs) || 3));
    for (const rel of refs) {
      slot.imageNumbers.push(addImage(`CHARACTER ${slot.letter} REFERENCE ("${slot.character.name}") — source of face, HAIR and body`, rel));
    }
  }

  const extras = Array.isArray(job.extras)
    ? job.extras.map((e) => e.prompt).filter(Boolean)
    : (opt.noProps !== false ? [LEGACY_NO_PROPS] : []);

  const hairOf = (slot) => appearanceLine(slot.character.appearance, 'HAIR');

  const lines = [];
  lines.push('You are a master digital artist specializing in high-quality 2D anime, manga and webtoon illustrations.');
  lines.push('');
  lines.push('**TASK**');
  lines.push(`Create a completely NEW 2D illustration based on the composition of Image 1 (SOURCE PHOTO), in which the real ${subjects.length > 1 ? 'people are' : 'person is'} replaced by the reference character${charSlots.size > 1 ? 's' : ''} below.`);
  lines.push('Do NOT simply filter, trace or paint over the photo. REDRAW everything from scratch in a 2D style.');
  lines.push('The real people in Image 1 are only "pose mannequins": their faces, HAIRSTYLES, hair colors and body shapes must NOT appear in the result.');
  lines.push('');
  lines.push('**INPUT IMAGES**');
  lines.push('- Image 1 (SOURCE PHOTO): real-life photo. Use it ONLY for skeletal pose, expression, composition, camera framing and background layout' + (subjects.some((s) => s.outfit === 'source') ? ', and as clothing reference where stated below.' : '.'));
  lines.push('  IGNORE completely: the real people\'s faces, hairstyles (length, bangs, parting, volume, ponytails, buns, curls), hair colors and body shapes.');
  if (hasGuide) {
    lines.push('- Image 2 (POSITION GUIDE): the same photo with numbered colored boxes that mark which person is which subject. Use it ONLY to identify the subjects. NEVER draw boxes, numbers or labels in the result.');
  }
  for (const slot of charSlots.values()) {
    const c = slot.character;
    const usesCharOutfit = subjects.some((s) => s.characterId === c.id && s.outfit !== 'source');
    const gender = GENDER_EN[c.gender] ? `${GENDER_EN[c.gender]} ` : '';
    lines.push(`- ${imgList(slot.imageNumbers)} (CHARACTER ${slot.letter} — "${c.name}"): ${gender}character design. Source for face, HAIR (style + color), eyes, body${usesCharOutfit ? ' and outfit' : ''}.`);
    if (c.appearance?.trim()) {
      lines.push(`  Character ${slot.letter} appearance sheet (authoritative):`);
      for (const l of c.appearance.trim().split(/\r?\n/).filter(Boolean)) {
        const isOutfit = /^\s*(OUTFIT|ACCESSORIES)\s*:/i.test(l);
        lines.push(`    ${l.trim()}${isOutfit && !usesCharOutfit ? '   (ignore — this character wears the source clothing)' : ''}`);
      }
    }
    if (c.description) lines.push(`  User notes for Character ${slot.letter}: ${c.description}`);
  }
  lines.push('');

  lines.push('**SUBJECT MAPPING (NON-NEGOTIABLE)**');
  subjects.forEach((s, i) => {
    const slot = charSlots.get(s.characterId);
    const hair = hairOf(slot);
    lines.push(`- Subject ${i + 1} = ${describeSubjectLocation(s, i, subjects, hasGuide)} → becomes CHARACTER ${slot.letter} ("${slot.character.name}", ${imgList(slot.imageNumbers)}). Hair: ${hair ? `${hair} — ` : ''}exactly as in ${imgList(slot.imageNumbers)}, NOT the real person's hair.`);
  });
  if (subjects.length > 1) {
    lines.push('- Never swap the characters. Keep every subject at exactly the same place in the frame, with the same depth order and the same overlaps as in Image 1.');
  }
  if (opt.others === 'remove') {
    lines.push('- Any OTHER people in the photo who are not listed above must be removed; fill the area with a natural continuation of the background.');
  } else {
    lines.push('- Any OTHER people in the photo who are not listed above stay where they are, redrawn as generic 2D background characters that do NOT resemble any reference character.');
  }
  lines.push('');

  lines.push('**STRICT REQUIREMENTS**');
  lines.push('1. **TOTAL STYLE CONVERSION**: The result must be a flat 2D illustration.');
  lines.push(`   - ${STYLE_TEXT[opt.style] || STYLE_TEXT.character}`);
  lines.push('   - NO photorealistic skin textures, NO realistic photographic lighting or shading.');
  lines.push('   - The background must be redrawn as a 2D painted anime-style background with the same layout as Image 1.');
  lines.push('2. **IDENTITY & BODY REPLACEMENT**:');
  lines.push('   - Extract ONLY the skeletal joint positions from Image 1. Do NOT trace the silhouette, body mass or body weight of the real people.');
  lines.push("   - Reconstruct each body with the anatomical proportions (height, shoulder width, waist, limb thickness) of the assigned character's reference images.");
  lines.push('3. **OUTFIT (PER SUBJECT)**:');
  subjects.forEach((s, i) => {
    const slot = charSlots.get(s.characterId);
    if (s.outfit === 'source') {
      lines.push(`   - Subject ${i + 1}: wear the SAME clothing this person wears in Image 1 (same garment types, colors, patterns and accessories), redrawn in 2D and REFIT to Character ${slot.letter}'s body. The clothes adapt to the body, never the other way around. Clothing comes from the photo, but face and HAIR still come only from Character ${slot.letter}.`);
    } else {
      lines.push(`   - Subject ${i + 1}: wear the EXACT outfit shown in Character ${slot.letter}'s reference images (same garments, colors, patterns, accessories). Completely IGNORE the clothing worn in Image 1 — treat the person as wearing a plain bodysuit before applying the costume. Re-drape the outfit onto the pose: fabric folds, skirt/coat flow, sleeves and hanging accessories follow the gravity and posture of Image 1.`);
    }
  });
  lines.push('');
  lines.push('🔒 **HAIR LOCK (HIGHEST PRIORITY — the most common mistake)**');
  lines.push("- Each character's hairstyle must be copied from THEIR OWN reference images: hair length, bangs/fringe shape, parting, volume, ahoge, side locks, ponytail / twin tails / bun / braid, curl pattern and hair color.");
  lines.push("- The real person's hair in Image 1 is IRRELEVANT. Treat every real head in Image 1 as if it were bald. Do NOT copy its length, cut, bangs, tied/untied state, color or highlights.");
  lines.push("- Only the head's pose (tilt and rotation) comes from Image 1; the hair then falls naturally from the CHARACTER's hairstyle with gravity and motion.");
  lines.push('- If a long-haired character replaces a short-haired person (or the reverse), the character keeps their own hair length.');
  lines.push('');
  lines.push('🔒 **FACE IDENTITY LOCK**');
  lines.push('- The final faces MUST NOT look like the real people in Image 1. Discard the real facial structure completely.');
  lines.push("- Copy face shape, eyes (shape and pupil color), eyebrows, nose, mouth, skin tone and overall aesthetic EXACTLY from each character's reference images.");
  lines.push('- Map the emotion / expression of each real person onto the anime face of their character. Replace realistic noses and lips with simplified 2D features.');
  lines.push('');
  lines.push('🔒 **BODY CONSTITUTION LOCK**');
  lines.push('- Do not preserve the body outline of the real people. If the real person is heavy and the character is slim, draw the character slim (and vice versa).');
  lines.push("- Each character's limb thickness, waistline, hips, chest and shoulder width must match their reference images, NOT Image 1.");
  lines.push('');
  lines.push('🔒 **SKELETAL POSE LOCK (NON-NEGOTIABLE)**');
  lines.push('- Copy the joint positions (neck, shoulders, elbows, wrists, spine, hips, knees, feet) from Image 1. The bones stay in place; the flesh around them follows the reference characters.');
  lines.push('- DO NOT change head tilt, gaze direction, neck rotation, shoulder height, spine curve, hip angle, knee bend, foot direction or hand placement. Even awkward poses must remain, adapted to the characters\' anatomy.');
  lines.push('');
  lines.push('🔒 **CAMERA & SPATIAL LOCK**');
  lines.push('- Camera position, focal perspective and framing MUST remain identical to Image 1. Do not zoom, crop, rotate or reframe.');
  lines.push('- Character scale relative to the frame stays similar, adjusted only for the characters\' canonical heights.');
  lines.push('');
  lines.push('🔒 **VISIBILITY & OCCLUSION RULE**');
  lines.push('- Only draw what is physically visible in Image 1. If a body part is hidden or cut off by the frame, it stays hidden.');
  lines.push('- Keep all overlap relationships between people and objects exactly as in Image 1.');
  if (extras.length) {
    lines.push('');
    lines.push('**EXTRA RULES (MUST FOLLOW)**');
    for (const e of extras) lines.push(`- ${e}`);
  }
  lines.push('');
  lines.push('**OUTPUT**: one single finished illustration. No text, captions, watermarks, borders, split panels or character sheets.');
  if (opt.extra?.trim()) {
    lines.push('');
    lines.push('**ADDITIONAL USER INSTRUCTIONS** (follow these too):');
    lines.push(opt.extra.trim());
  }
  lines.push('');
  lines.push('**FINAL CHECK before you output**: for every subject, compare the drawn hair with that character\'s reference images — same length, same bangs, same tied/untied style, same color. If it resembles the real person\'s hair instead, redraw it.');
  subjects.forEach((s, i) => {
    const slot = charSlots.get(s.characterId);
    const hair = hairOf(slot);
    lines.push(`- Subject ${i + 1} → "${slot.character.name}"${hair ? `: ${hair}` : ''}`);
  });

  return labeledParts(images, lines.join('\n'));
}

const CENSOR_EN = {
  gray: 'flat solid gray patches',
  black: 'flat solid black patches',
  white: 'flat solid white patches',
  mosaic: 'pixelated mosaic patches',
};

function censorRule(job) {
  if (!job.censorFill) return [];
  return [
    `- Some areas of Image 1 are covered by ${CENSOR_EN[job.censorFill] || CENSOR_EN.gray}. They are intentional placeholders that will be replaced later.`,
    '  Leave every such patch exactly as it is (same shape, same position, same flat fill). Do not remove, reinterpret, extend or draw anything over them, and do not let them affect the rest of the image.',
  ];
}

const COLOR_STYLE_TEXT = {
  official: "the publisher's OFFICIAL full-color digital edition: clean cel shading with subtle soft gradients, a rich but natural palette and professional finishing",
  anime: 'a TV-anime adaptation look: crisp two-tone cel shading, bright saturated anime palette, clean highlights',
  painterly: 'a premium full-color webtoon look: soft painterly gradients, atmospheric lighting, glow and depth',
};

const PAD_RULE = '- Keep the exact same canvas size and framing as Image 1. Do not crop, zoom, shift or add borders; content near the edges stays where it is.';

export function buildColorizeParts(job, { loadImage, getCharacter }) {
  const opt = job.options || {};
  const images = [{ label: 'BLACK-AND-WHITE MANGA PAGE', image: loadImage(job.sendFile || job.sourceFile) }];
  const refLines = [];
  for (const id of opt.refs || []) {
    const c = getCharacter(id);
    if (!c?.images?.length) continue;
    const nums = [];
    for (const rel of c.images.slice(0, 2)) {
      if (images.length >= MAX_INPUT_IMAGES) break;
      images.push({ label: `COLOR REFERENCE — "${c.name}"`, image: loadImage(rel) });
      nums.push(images.length);
    }
    if (nums.length) {
      const colors = ['HAIR', 'EYES', 'OUTFIT'].map((k) => appearanceLine(c.appearance, k)).filter(Boolean).join('; ');
      refLines.push(`- ${imgList(nums)}: color reference for the character "${c.name}"${c.description ? ` (${c.description})` : ''}${colors ? ` — ${colors}` : ''}. When this character appears on the page, use exactly these hair, eye, skin and outfit colors.`);
    }
  }

  const lines = [];
  lines.push('You are a professional manga colorist producing the OFFICIAL DIGITAL COLOR VERSION of a black-and-white manga page.');
  lines.push('');
  lines.push('**INPUT IMAGES**');
  lines.push('- Image 1: the original black-and-white manga page.');
  lines.push(...refLines);
  lines.push('');
  lines.push('**TASK**');
  lines.push(`Fully colorize Image 1 so that it looks like ${COLOR_STYLE_TEXT[opt.style] || COLOR_STYLE_TEXT.official}.`);
  lines.push('');
  lines.push('🔒 **LINE ART LOCK (NON-NEGOTIABLE)**');
  lines.push('- Preserve the original line art exactly: every line, panel border, gutter, composition, pose, facial expression and background detail stays where it is.');
  lines.push('- Do not redraw, restyle, add, remove, move or "improve" anything. Same framing, same page layout, no cropping or extending.');
  if (job.pad) lines.push(PAD_RULE);
  lines.push('');
  if (opt.keepText !== false) {
    lines.push('🔒 **TEXT LOCK**');
    lines.push('- Keep all dialogue, narration, speech bubbles, sound effects (SFX) and lettering exactly as they are — same characters, same font look, same position. Do not translate, retype or re-letter.');
    lines.push('- Speech bubble interiors stay clean white unless the original uses a stylized bubble.');
    lines.push('');
  }
  lines.push('**COLORING RULES**');
  lines.push('- Convert screentones / halftone dot patterns that represent shading or color into proper flat colors and smooth gradients; keep tone patterns that are clearly intentional visual effects.');
  lines.push('- Accurate, natural skin tones; distinct hair and eye colors; clothing colors that suit the characters and setting.');
  lines.push('- Consistency: each character keeps the same hair, eye, skin and clothing colors in every panel of the page.');
  lines.push('- Lighting and background colors follow each scene (time of day, indoor/outdoor, mood). Effects (speed lines, glows, magic, etc.) get appropriate colors.');
  lines.push('- Keep black ink lines black and crisp; color is applied underneath the line art, not over it.');
  lines.push(...censorRule(job));
  lines.push('');
  lines.push('**OUTPUT**: the complete page in full color, nothing else — no added text, watermark, border or extra panels.');
  if (opt.extra?.trim()) {
    lines.push('');
    lines.push('**ADDITIONAL USER INSTRUCTIONS** (follow these too):');
    lines.push(opt.extra.trim());
  }
  return labeledParts(images, lines.join('\n'));
}

// Free mode: the user's prompt with the attached images, nothing added.
export function buildFreeParts(job, { loadImage }) {
  const prompt = (job.prompt || '').trim();
  if (!prompt) throw new Error('프롬프트가 비어 있습니다.');
  const files = (job.inputFiles || []).slice(0, MAX_INPUT_IMAGES);
  if (!files.length) return [{ text: prompt }];
  const parts = [];
  files.forEach((rel, i) => {
    if (files.length > 1) parts.push({ text: `Image ${i + 1}:` });
    parts.push(inlinePart(loadImage(rel)));
  });
  parts.push({ text: prompt });
  return parts;
}

export function buildInpaintParts(job, { loadImage }) {
  const instruction = [job.options?.prompt, job.prompt].map((s) => (s || '').trim()).filter(Boolean).join('\n');
  if (!instruction) throw new Error('프롬프트가 비어 있습니다.');
  const images = [{ label: 'IMAGE TO EDIT', image: loadImage(job.sendFile || job.sourceFile) }];
  const hasGuide = Boolean(job.guideFile);
  if (hasGuide) images.push({ label: 'EDIT REGION GUIDE (red = area to change)', image: loadImage(job.guideFile) });
  const refStart = images.length + 1;
  for (const rel of (job.refFiles || []).slice(0, MAX_INPUT_IMAGES - images.length)) {
    images.push({ label: 'REFERENCE (supplied by the user)', image: loadImage(rel) });
  }
  const refCount = images.length - refStart + 1;

  const lines = [];
  lines.push('You are an expert image editor performing a precise inpainting edit.');
  lines.push('');
  lines.push('**INPUT IMAGES**');
  lines.push('- Image 1: the image to edit.');
  if (hasGuide) lines.push('- Image 2: the same image with the EDIT REGION highlighted in translucent red. It only marks where to work — never draw the red highlight.');
  if (refCount > 0) lines.push(`- ${imgList(Array.from({ length: refCount }, (_, i) => refStart + i))}: reference image(s) supplied by the user; use them as described in the instruction.`);
  lines.push('');
  lines.push('**INSTRUCTION**');
  lines.push(instruction);
  lines.push('');
  lines.push('**RULES**');
  if (hasGuide) {
    lines.push('- Change ONLY the red-marked region of Image 2. Everything outside it must stay identical to Image 1: same composition, framing, colors, lighting, line work and style.');
    lines.push('- The new content must blend seamlessly with the surrounding pixels: matching perspective, lighting, color grading, grain, line weight and art style.');
  } else {
    lines.push('- Apply the instruction to Image 1 while keeping everything the instruction does not mention unchanged: same composition, framing, colors, lighting and style.');
  }
  lines.push(PAD_RULE);
  lines.push(...censorRule(job));
  lines.push('- Output the full edited image only — no text, borders or side-by-side comparison.');
  return labeledParts(images, lines.join('\n'));
}

// Text-only request that writes an appearance sheet for a library character.
export function buildDescribeParts(character, { loadImage }) {
  const parts = [];
  character.images.slice(0, 3).forEach((rel, i) => {
    parts.push({ text: `Reference image ${i + 1}:` });
    parts.push(inlinePart(loadImage(rel)));
  });
  parts.push({ text: [
    `These images show one 2D character${character.name ? ` named "${character.name}"` : ''}.`,
    'Write a precise visual appearance sheet that an illustrator can use to redraw this exact character. English only. Output exactly these 7 lines and nothing else:',
    'HAIR: length, bangs/fringe shape, parting, side locks, ahoge, tied style (ponytail/twin tails/bun/braid/loose), volume, curl pattern, exact color and highlights',
    'EYES: shape, exact iris color, eyelashes',
    'FACE: face shape, skin tone, notable marks (moles, scars, blush)',
    'BODY: apparent age, height impression, build/proportions',
    'OUTFIT: every garment with colors, patterns and details, top to bottom, including footwear',
    'ACCESSORIES: hair ornaments, jewelry, bags, gloves, etc. (or "none")',
    'STYLE: art style of the references (line weight, shading)',
    'Be concrete and specific (e.g. "waist-length straight silver hair, blunt bangs covering the eyebrows, two thin side locks to the chest, no ahoge").',
  ].join('\n') });
  return parts;
}
