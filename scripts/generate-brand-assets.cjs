/* Optional maintainer utility; the app uses the checked-in PNGs, not Sharp. */
const fs = require('node:fs/promises');
const path = require('node:path');
const { Buffer } = require('node:buffer');
const sharp = require(process.env.PICKLY_BRAND_SHARP_MODULE || 'sharp');

const output = path.resolve(path.dirname(module.filename), '../assets/brand');
const blue = '#1E3F7C';
const yellow = '#D6F22E';
const paddle = 'M64 4C30 4 4 31 4 64c0 33 25 54 43 79 6 8 8 15 8 21v12l9 12 9-12v-12c0-6 2-13 8-21 18-25 43-46 43-79C124 31 98 4 64 4Z';
const wrap = (content, viewBox = '0 0 128 192') => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${content}</svg>`;
const holes = [[64, 64], [64, 43], [82, 54], [82, 75], [64, 85], [46, 75], [46, 54]];
const detail = (outer, inner) => `<path fill="${outer}" d="${paddle}"/><circle cx="64" cy="64" r="38" fill="${inner}"/><g fill="${outer}">${holes.map(([cx, cy]) => `<circle cx="${cx}" cy="${cy}" r="5.5"/>`).join('')}</g><path stroke="${inner}" stroke-width="3" d="M55 166h18m-18 7h18"/>`;

async function svgAndPng(name, source, width, height) {
  await fs.writeFile(path.join(output, `${name}.svg`), source);
  const rendered = sharp(Buffer.from(source)).resize(width, height);
  if (name === 'app-icon') rendered.removeAlpha();
  await rendered.png().toFile(path.join(output, `${name}.png`));
}

async function main() {
  // Both full marks retain their editable SVG masters.
  for (const name of ['mark', 'mark-white']) {
    const source = await fs.readFile(path.join(output, `${name}.svg`));
    await sharp(source).resize(128, 192).png().toFile(path.join(output, `${name}.png`));
  }
  const small = wrap(`<defs><mask id="center"><rect width="128" height="192" fill="white"/><circle cx="64" cy="64" r="38" fill="black"/></mask></defs><path fill="${blue}" mask="url(#center)" d="${paddle}"/>`);
  await svgAndPng('mark-small', small, 64, 96);
  const icon = wrap(`<rect width="1024" height="1024" fill="${blue}"/><g transform="translate(304 200) scale(3.25)">${detail(yellow, blue)}</g>`, '0 0 1024 1024');
  // iOS supplies the corner mask. The source is square and fully opaque.
  await svgAndPng('app-icon', icon, 1024, 1024);
  for (const [name, outer, inner] of [['court-pin', blue, yellow], ['court-pin-selected', yellow, blue]]) {
    // Simplified ball at small sizes; white rim keeps it visible on the basemap.
    const source = wrap(`<path fill="${outer}" stroke="white" stroke-width="5" stroke-linejoin="round" d="${paddle}"/><circle cx="64" cy="64" r="38" fill="${inner}"/>`);
    await fs.writeFile(path.join(output, `${name}.svg`), source);
    for (const density of [1, 2, 3]) {
      const suffix = density === 1 ? '' : `@${density}x`;
      await sharp(Buffer.from(source)).resize(32 * density, 48 * density).png().toFile(path.join(output, `${name}${suffix}.png`));
    }
  }
  console.log('Generated Concept C brand PNGs and SVG masters.');
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
