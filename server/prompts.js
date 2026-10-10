// Prompt + multimodal part builders for the two job types.

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

const STYLE_TEXT = {
  character: 'Match the art style of the CHARACTER REFERENCE images (line weight, coloring, cel shading, eye and hair rendering). If the references use different styles, unify everything into one consistent 2D style.',
  anime: 'High-budget modern TV anime style: clean line art, crisp cel shading, vivid colors — it should look like a screenshot from a high-quality anime.',
  webtoon: 'Full-color Korean webtoon (manhwa) style: clean digital line art, soft gradient shading, polished glossy coloring.',
  manga: 'Japanese manga illustration style with clean ink line art and soft digital coloring, like a full-color manga cover illustration.',
};

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

  addImage('SOURCE PHOTO', job.sourceFile);
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
      slot.imageNumbers.push(addImage(`CHARACTER ${slot.letter} REFERENCE`, rel));
    }
  }

  const imgList = (nums) => (nums.length === 1 ? `Image ${nums[0]}` : `Images ${nums.join(', ')}`);
  const lines = [];
  lines.push('You are a master digital artist specializing in high-quality 2D anime, manga and webtoon illustrations.');
  lines.push('');
  lines.push('**TASK**');
  lines.push(`Create a completely NEW 2D illustration based on the composition of Image 1 (SOURCE PHOTO), in which the real ${subjects.length > 1 ? 'people are' : 'person is'} replaced by the reference character${charSlots.size > 1 ? 's' : ''} below.`);
  lines.push('Do NOT simply filter, trace or paint over the photo. REDRAW everything from scratch in a 2D style.');
  lines.push('');
  lines.push('**INPUT IMAGES**');
  lines.push('- Image 1 (SOURCE PHOTO): real-life photo. Use it ONLY for skeletal pose, expression, composition, camera framing and background layout' + (subjects.some((s) => s.outfit === 'source') ? ', and as clothing reference where stated below.' : '.'));
  if (hasGuide) {
    lines.push('- Image 2 (POSITION GUIDE): the same photo with numbered colored boxes that mark which person is which subject. Use it ONLY to identify the subjects. NEVER draw boxes, numbers or labels in the result.');
  }
  for (const slot of charSlots.values()) {
    const c = slot.character;
    const usesCharOutfit = subjects.some((s) => s.characterId === c.id && s.outfit !== 'source');
    const gender = GENDER_EN[c.gender] ? `${GENDER_EN[c.gender]} ` : '';
    lines.push(`- ${imgList(slot.imageNumbers)} (CHARACTER ${slot.letter} — "${c.name}"): ${gender}character design. Source for face, hair, body${usesCharOutfit ? ' and outfit' : ''}.${c.description ? ` Notes: ${c.description}` : ''}`);
  }
  lines.push('');

  lines.push('**SUBJECT MAPPING (NON-NEGOTIABLE)**');
  subjects.forEach((s, i) => {
    const slot = charSlots.get(s.characterId);
    lines.push(`- Subject ${i + 1} = ${describeSubjectLocation(s, i, subjects, hasGuide)} → becomes CHARACTER ${slot.letter} ("${slot.character.name}", ${imgList(slot.imageNumbers)}).`);
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
      lines.push(`   - Subject ${i + 1}: wear the SAME clothing this person wears in Image 1 (same garment types, colors, patterns and accessories), redrawn in 2D and REFIT to Character ${slot.letter}'s body. The clothes adapt to the body, never the other way around.`);
    } else {
      lines.push(`   - Subject ${i + 1}: wear the EXACT outfit shown in Character ${slot.letter}'s reference images (same garments, colors, patterns, accessories). Completely IGNORE the clothing worn in Image 1 — treat the person as wearing a plain bodysuit before applying the costume. Re-drape the outfit onto the pose: fabric folds, skirt/coat flow, sleeves and hanging accessories follow the gravity and posture of Image 1.`);
    }
  });
  if (opt.noProps !== false) {
    lines.push('   - Do not add bags, weapons or handheld props from the character references unless the person in Image 1 is actually holding something there.');
  }
  lines.push('');
  lines.push('🔒 **BODY CONSTITUTION LOCK (CRITICAL)**');
  lines.push('- Do not preserve the body outline of the real people. If the real person is heavy and the character is slim, draw the character slim (and vice versa).');
  lines.push("- Each character's limb thickness, waistline, hips, chest and shoulder width must match their reference images, NOT Image 1.");
  lines.push('');
  lines.push('🔒 **FACE IDENTITY LOCK (HIGHEST PRIORITY)**');
  lines.push('- The final faces MUST NOT look like the real people in Image 1. Discard the real facial structure completely.');
  lines.push("- Copy face shape, eyes (shape and pupil color), eyebrows, nose, mouth, hairstyle, hair color, skin tone and overall aesthetic EXACTLY from each character's reference images.");
  lines.push('- Map the emotion / expression of each real person onto the anime face of their character. Replace realistic noses and lips with simplified 2D features.');
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
  lines.push('');
  lines.push('**OUTPUT**: one single finished illustration. No text, captions, watermarks, borders, split panels or character sheets.');
  if (opt.extra?.trim()) {
    lines.push('');
    lines.push('**ADDITIONAL USER INSTRUCTIONS** (follow these too):');
    lines.push(opt.extra.trim());
  }

  const parts = [];
  images.forEach((img, i) => {
    parts.push({ text: `Image ${i + 1} — ${img.label}:` });
    parts.push(inlinePart(img.image));
  });
  parts.push({ text: lines.join('\n') });
  return parts;
}

const COLOR_STYLE_TEXT = {
  official: "the publisher's OFFICIAL full-color digital edition: clean cel shading with subtle soft gradients, a rich but natural palette and professional finishing",
  anime: 'a TV-anime adaptation look: crisp two-tone cel shading, bright saturated anime palette, clean highlights',
  painterly: 'a premium full-color webtoon look: soft painterly gradients, atmospheric lighting, glow and depth',
};

export function buildColorizeParts(job, { loadImage, getCharacter }) {
  const opt = job.options || {};
  const images = [{ label: 'BLACK-AND-WHITE MANGA PAGE', image: loadImage(job.sourceFile) }];
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
      refLines.push(`- ${nums.length === 1 ? `Image ${nums[0]}` : `Images ${nums.join(', ')}`}: color reference for the character "${c.name}"${c.description ? ` (${c.description})` : ''}. When this character appears on the page, use exactly these hair, eye, skin and outfit colors.`);
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
  lines.push('');
  lines.push('**OUTPUT**: the complete page in full color, nothing else — no added text, watermark, border or extra panels.');
  if (opt.extra?.trim()) {
    lines.push('');
    lines.push('**ADDITIONAL USER INSTRUCTIONS** (follow these too):');
    lines.push(opt.extra.trim());
  }

  const parts = [];
  images.forEach((img, i) => {
    parts.push({ text: `Image ${i + 1} — ${img.label}:` });
    parts.push(inlinePart(img.image));
  });
  parts.push({ text: lines.join('\n') });
  return parts;
}
