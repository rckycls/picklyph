/* Optional maintainer utility: rebuilds the checked-in H04 venue collection template, a plain .xlsx
   (zip of XML) written with Node built-ins only. Usage: node scripts/generate-venue-collection.cjs [output] */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { Buffer } = require('node:buffer');

const OUT = process.argv[2] || path.resolve(path.dirname(module.filename), '../docs/templates/h04-venue-collection.xlsx');
const V_LAST = 201; // 200 venue rows
const C_LAST = 1001; // 1000 court rows
const P_LAST = 201; // 200 permission rows

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const letter = (n) => { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
const balanced = (f) => { let d = 0; for (const ch of f.replace(/"[^"]*"/g, '')) { if (ch === '(') d++; if (ch === ')') d--; if (d < 0) return false; } return d === 0; };
// Builds IF(c1,m1,IF(c2,m2,...,last)) without hand-counting parentheses.
const chain = (pairs, last) => pairs.reduceRight((acc, [cond, msg]) => `IF(${cond},"${msg}",${acc})`, `"${last}"`);

// Style ids (cellXfs order below).
const S = { header: 1, text: 2, coord: 3, auto: 4, date: 5, title: 6, section: 7, body: 8, autoHeader: 9 };

const LISTS = [
  ['Region', ['NCR – Metro Manila', 'CAR – Cordillera', 'I – Ilocos', 'II – Cagayan Valley', 'III – Central Luzon', 'IV-A – CALABARZON', 'MIMAROPA', 'V – Bicol', 'VI – Western Visayas', 'NIR – Negros Island', 'VII – Central Visayas', 'VIII – Eastern Visayas', 'IX – Zamboanga Peninsula', 'X – Northern Mindanao', 'XI – Davao', 'XII – SOCCSKSARGEN', 'XIII – Caraga', 'BARMM']],
  ['Yes/No', ['Yes', 'No']],
  ['Surface', ['Hard', 'Synthetic', 'Other', 'Not sure']],
  ['Pin checked by', ['Owner or manager', 'Site visit', 'Not yet']],
  ['Permission', ['Yes', 'Pending', 'No']],
  ['Role', ['Owner', 'Manager', 'Staff', 'Other']],
  ['How they agreed', ['In person', 'Message', 'Email', 'Phone call']],
];
const listRef = (name) => { const i = LISTS.findIndex(([n]) => n === name); const c = letter(i + 1); return `Lists!$${c}$2:$${c}$${LISTS[i][1].length + 1}`; };

function cellXml(ref, cell) {
  const s = cell.s ? ` s="${cell.s}"` : '';
  if (cell.f) { if (!balanced(cell.f)) throw new Error(`unbalanced formula at ${ref}`); return `<c r="${ref}"${s}><f>${esc(cell.f)}</f></c>`; }
  if (typeof cell.v === 'number') return `<c r="${ref}"${s}><v>${cell.v}</v></c>`;
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${esc(cell.v)}</t></is></c>`;
}

function dvXml(d) {
  const check = (label, text, max) => { if (text && text.length > max) throw new Error(`${label} too long (${text.length}): ${text}`); };
  check('promptTitle', d.promptTitle, 32); check('errorTitle', d.errorTitle, 32); check('prompt', d.prompt, 255); check('error', d.error, 255);
  const attrs = [`type="${d.type}"`];
  if (d.operator) attrs.push(`operator="${d.operator}"`);
  attrs.push('allowBlank="1"', 'showInputMessage="1"', `showErrorMessage="${d.type === 'none' ? 0 : 1}"`);
  if (d.errorTitle) attrs.push(`errorTitle="${esc(d.errorTitle)}"`, `error="${esc(d.error)}"`);
  if (d.prompt) attrs.push(`promptTitle="${esc(d.promptTitle)}"`, `prompt="${esc(d.prompt)}"`);
  attrs.push(`sqref="${d.sqref}"`);
  const f1 = d.f1 === undefined ? '' : `<formula1>${esc(d.f1)}</formula1>`;
  const f2 = d.f2 === undefined ? '' : `<formula2>${esc(d.f2)}</formula2>`;
  return `<dataValidation ${attrs.join(' ')}>${f1}${f2}</dataValidation>`;
}

function sheetXml({ cols, rows, freezeRow = false, cf = [], dv = [], selected = false }) {
  const pane = freezeRow ? '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/>' : '<selection activeCell="A1" sqref="A1"/>';
  const colXml = cols.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.w}"${c.s ? ` style="${c.s}"` : ''} customWidth="1"/>`).join('');
  const rowXml = rows.map((row) => {
    const ht = row.ht ? ` ht="${row.ht}" customHeight="1"` : '';
    return `<row r="${row.r}"${ht}>${row.cells.map((cell) => cellXml(`${cell.col}${row.r}`, cell)).join('')}</row>`;
  }).join('');
  let priority = 0;
  const cfXml = cf.map((block) => `<conditionalFormatting sqref="${block.sqref}">${block.rules.map((rule) => `<cfRule type="expression" dxfId="${rule.dxf}" priority="${++priority}"><formula>${esc(rule.f)}</formula></cfRule>`).join('')}</conditionalFormatting>`).join('');
  const dvBlock = dv.length ? `<dataValidations count="${dv.length}">${dv.map(dvXml).join('')}</dataValidations>` : '';
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + `<sheetViews><sheetView${selected ? ' tabSelected="1"' : ''} workbookViewId="0">${pane}</sheetView></sheetViews>`
    + '<sheetFormatPr defaultRowHeight="15"/>'
    + `<cols>${colXml}</cols><sheetData>${rowXml}</sheetData>${cfXml}${dvBlock}`
    + '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>';
}

// A data sheet: a header row, auto (formula) columns filled down, per-column validation.
function dataSheet(columns, last, extra = {}) {
  const header = { r: 1, ht: 32, cells: columns.map((c, i) => ({ col: letter(i + 1), v: c.title, s: c.auto ? S.autoHeader : S.header })) };
  const rows = [header];
  for (let r = 2; r <= last; r++) {
    const cells = [];
    columns.forEach((c, i) => { if (c.auto) cells.push({ col: letter(i + 1), f: c.auto(r), s: S.auto }); });
    if (cells.length) rows.push({ r, cells });
  }
  const dv = [];
  columns.forEach((c, i) => { if (c.dv) dv.push({ ...c.dv, sqref: `${letter(i + 1)}2:${letter(i + 1)}${last}` }); });
  return sheetXml({ cols: columns.map((c) => ({ w: c.w, s: c.auto ? S.auto : c.s })), rows, freezeRow: true, dv, ...extra });
}

const list = (name, promptTitle, prompt, error = 'Choose a value from the list.') => ({ type: 'list', f1: listRef(name), promptTitle, prompt, errorTitle: 'Not in the list', error });
const length = (min, max, promptTitle, prompt) => ({ type: 'textLength', operator: 'between', f1: String(min), f2: String(max), promptTitle, prompt, errorTitle: 'Too long', error: `Use ${min} to ${max} characters.` });
const VENUE_CODES = `Venues!$A$2:$A$${V_LAST}`;

const venues = dataSheet([
  { title: 'Venue code *', w: 14, s: S.text, dv: { type: 'custom', f1: `AND(LEN(A2)<=40,ISERROR(FIND(" ",A2)),COUNTIF($A$2:$A$${V_LAST},A2)=1)`, promptTitle: 'Venue code', prompt: 'A short code you make up, such as NCR-001. Unique, no spaces. It becomes the permanent import reference, so never change or reuse it after import.', errorTitle: 'Check the code', error: 'Use a unique code of up to 40 characters with no spaces, such as NCR-001.' } },
  { title: 'Venue name *', w: 34, s: S.text, dv: length(1, 120, 'Venue name', 'As the venue wants it shown in the app. Up to 120 characters.') },
  { title: 'Street address *', w: 44, s: S.text, dv: length(1, 240, 'Street address', 'Street, building and barangay. Up to 240 characters.') },
  { title: 'City or municipality *', w: 22, s: S.text, dv: length(1, 80, 'City or municipality', 'Such as Pasig or Lapu-Lapu. Up to 80 characters.') },
  { title: 'Province *', w: 20, s: S.text, dv: length(1, 80, 'Province', 'Such as Cebu or Davao del Sur. For Metro Manila, write Metro Manila.') },
  { title: 'Region', w: 24, dv: list('Region', 'Region', 'For planning the spread across the country. Not imported.') },
  { title: 'Latitude *', w: 13, s: S.coord, dv: { type: 'decimal', operator: 'between', f1: '4', f2: '21.5', promptTitle: 'Latitude', prompt: 'In Google Maps, press and hold on the courts (not the street), then copy the FIRST number shown, such as 14.554729.', errorTitle: 'Check the latitude', error: 'Latitude in the Philippines is between 4 and 21.5. It is the first of the two Google Maps numbers.' } },
  { title: 'Longitude *', w: 13, s: S.coord, dv: { type: 'decimal', operator: 'between', f1: '116', f2: '127', promptTitle: 'Longitude', prompt: 'The SECOND number from Google Maps, such as 121.024445.', errorTitle: 'Check the longitude', error: 'Longitude in the Philippines is between 116 and 127. It is the second of the two Google Maps numbers.' } },
  { title: 'Pin checked by *', w: 19, dv: list('Pin checked by', 'Pin checked by', 'Who confirmed the pin sits on the courts: the owner or manager, or you on a site visit. Choose Not yet until then.') },
  { title: 'Permission to list *', w: 14, dv: list('Permission', 'Permission to list', 'Yes only after the owner or manager agreed to the listing. Record who, when and how on the Permissions sheet.') },
  { title: 'Courts listed (auto)', w: 11, auto: (r) => `IF(A${r}="","",COUNTIF(Courts!$A$2:$A$${C_LAST},A${r}))` },
  { title: 'Active courts (auto)', w: 11, auto: (r) => `IF(A${r}="","",COUNTIFS(Courts!$A$2:$A$${C_LAST},A${r},Courts!$F$2:$F$${C_LAST},"Yes"))` },
  { title: 'Status (auto)', w: 28, auto: (r) => `IF(A${r}="","",${chain([
    [`COUNTIF($A$2:$A$${V_LAST},A${r})>1`, 'Duplicate venue code'],
    [`OR(B${r}="",C${r}="",D${r}="",E${r}="",G${r}="",H${r}="",I${r}="",J${r}="")`, 'Missing details'],
    [`OR(LEN(A${r})>40,LEN(B${r})>120,LEN(C${r})>240,LEN(D${r})>80,LEN(E${r})>80)`, 'Text too long'],
    [`OR(NOT(ISNUMBER(G${r})),NOT(ISNUMBER(H${r})))`, 'Pin must be two numbers'],
    [`OR(G${r}<4,G${r}>21.5,H${r}<116,H${r}>127)`, 'Pin outside the Philippines'],
    [`J${r}="No"`, 'No permission: do not import'],
    [`J${r}<>"Yes"`, 'Waiting for permission'],
    [`AND(I${r}<>"Owner or manager",I${r}<>"Site visit")`, 'Confirm the pin'],
    [`K${r}=0`, 'Add its courts'],
    [`K${r}>40`, 'Over 40 courts'],
    [`COUNTIFS(Courts!$A$2:$A$${C_LAST},A${r},Courts!$G$2:$G$${C_LAST},"<>OK")>0`, 'Fix its courts'],
    [`L${r}=0`, 'Needs an active court'],
  ], 'Ready')})` },
  { title: 'Notes (not imported)', w: 40, s: S.text },
], V_LAST, { selected: false, cf: [{ sqref: `M2:M${V_LAST}`, rules: [{ dxf: 0, f: '$M2="Ready"' }, { dxf: 1, f: 'AND($M2<>"",$M2<>"Ready")' }] }] });

const courts = dataSheet([
  { title: 'Venue code *', w: 14, s: S.text, dv: { type: 'list', f1: VENUE_CODES, promptTitle: 'Venue code', prompt: 'Choose the venue code from the Venues sheet. Add one row per court.', errorTitle: 'Unknown venue', error: 'Choose a code that exists on the Venues sheet.' } },
  { title: 'Court name *', w: 22, s: S.text, dv: { type: 'custom', f1: `AND(LEN(B2)>=1,LEN(B2)<=80,COUNTIFS($A$2:$A$${C_LAST},A2,$B$2:$B$${C_LAST},B2)=1)`, promptTitle: 'Court name', prompt: 'As the venue calls it, such as Court 1. Each name once per venue, up to 80 characters, at most 40 courts per venue.', errorTitle: 'Check the court name', error: 'Court names must be unique within a venue and up to 80 characters.' } },
  { title: 'Surface', w: 14, dv: list('Surface', 'Surface', 'Hard (concrete, asphalt or painted court), Synthetic (sport tiles, mats or turf), Other, or Not sure.') },
  { title: 'Indoor? *', w: 10, dv: list('Yes/No', 'Indoor?', 'Yes if the court is inside a building.') },
  { title: 'Covered? *', w: 11, dv: list('Yes/No', 'Covered?', 'Yes if players are under a roof.') },
  { title: 'Active? *', w: 10, dv: list('Yes/No', 'Active?', 'Yes if it can be played on now. No for a court that is closed for now. A venue needs at least one active court to be published.') },
  { title: 'Check (auto)', w: 24, auto: (r) => `IF(A${r}="","",${chain([
    [`COUNTIF(${VENUE_CODES},A${r})=0`, 'Unknown venue code'],
    [`OR(B${r}="",D${r}="",E${r}="",F${r}="")`, 'Missing details'],
    [`LEN(B${r})>80`, 'Name too long'],
    [`COUNTIFS($A$2:$A$${C_LAST},A${r},$B$2:$B$${C_LAST},B${r})>1`, 'Duplicate court name'],
    [`AND(C${r}<>"",C${r}<>"Hard",C${r}<>"Synthetic",C${r}<>"Other",C${r}<>"Not sure")`, 'Unknown surface'],
    [`OR(AND(D${r}<>"Yes",D${r}<>"No"),AND(E${r}<>"Yes",E${r}<>"No"),AND(F${r}<>"Yes",F${r}<>"No"))`, 'Use Yes or No'],
  ], 'OK')})` },
  { title: 'Notes (not imported)', w: 40, s: S.text },
], C_LAST, { cf: [{ sqref: `G2:G${C_LAST}`, rules: [{ dxf: 0, f: '$G2="OK"' }, { dxf: 1, f: 'AND($G2<>"",$G2<>"OK")' }] }] });

const permissions = dataSheet([
  { title: 'Venue code *', w: 14, s: S.text, dv: { type: 'list', f1: VENUE_CODES, promptTitle: 'Venue code', prompt: 'Choose the venue code from the Venues sheet.', errorTitle: 'Unknown venue', error: 'Choose a code that exists on the Venues sheet.' } },
  { title: 'Person who agreed *', w: 24, s: S.text, dv: length(1, 120, 'Person who agreed', 'Full name of the person who agreed to the listing.') },
  { title: 'Their role *', w: 13, dv: list('Role', 'Their role', 'Their role at the venue.') },
  { title: 'Phone or email *', w: 26, s: S.text, dv: { type: 'none', promptTitle: 'Phone or email', prompt: 'How to reach them. Private: never imported or shown in the app.' } },
  { title: 'How they agreed *', w: 16, dv: list('How they agreed', 'How they agreed', 'In person, by message, by email or on a phone call.') },
  { title: 'Date agreed *', w: 13, s: S.date, dv: { type: 'date', operator: 'greaterThanOrEqual', f1: '45658', promptTitle: 'Date agreed', prompt: 'The date they agreed, such as 2026-10-13.', errorTitle: 'Check the date', error: 'Enter a date from 2025 onwards, such as 2026-10-13.' } },
  { title: 'Where the proof is saved *', w: 40, s: S.text, dv: { type: 'none', promptTitle: 'Proof', prompt: 'Where the proof is kept, such as a Messenger screenshot in a private Drive folder.' } },
  { title: 'Invited to claim in the app?', w: 16, dv: list('Yes/No', 'Invited to claim?', 'Yes once you have asked them to claim the listing in the PicklyPH app, so they can add hours, photos and session prices.') },
  { title: 'Notes', w: 40, s: S.text },
], P_LAST);

const START = [
  ['title', 'PicklyPH venue collection (H04)'],
  ['body', 'Use this workbook to collect real venues for the directory. Fill one row per venue on Venues and one row per court on Courts, and keep the permission record on Permissions. Columns marked * are required. Click a cell to see a short hint.'],
  [],
  ['section', 'Before you add a venue'],
  ['body', '1. Ask the owner or manager whether PicklyPH may list the venue. Record who agreed, how and when on Permissions, and keep the proof (a message screenshot is fine).'],
  ['body', '2. Check that the venue is not already in the PicklyPH directory. A second row for the same venue creates a duplicate listing.'],
  [],
  ['section', 'Venues'],
  ['body', 'Venue code: a short code you make up, such as NCR-001 or CEB-003, with no spaces. It becomes the venue\'s permanent import reference, so never change or reuse a code once the venue is imported.'],
  ['body', 'Name, street address, city or municipality, province: as the venue wants them shown. Up to 120 characters for the name, 240 for the address and 80 for city and province.'],
  ['body', 'Region: for planning a spread across the country. It is not imported.'],
  ['body', 'Latitude and longitude: in Google Maps, press and hold on the courts themselves (not the street), then copy the two numbers shown, such as 14.554729, 121.024445. The first is latitude, the second longitude.'],
  ['body', 'Pin checked by: confirm the pin with the owner or manager, or on a site visit. The console only checks that the numbers are valid, not that they match the address.'],
  ['body', 'Permission to list: Yes only after the owner or manager agreed.'],
  ['body', 'Courts listed, Active courts and Status fill themselves. Status says what is still missing. A venue is ready to import when it says Ready.'],
  [],
  ['section', 'Courts'],
  ['body', 'One row per court. Choose the venue code from the list.'],
  ['body', 'Court name: as the venue calls it, such as Court 1 or Center Court. Each name only once per venue, up to 80 characters, and at most 40 courts per venue.'],
  ['body', 'Surface: Hard, Synthetic, Other, or Not sure. Indoor, Covered and Active: Yes or No. Set Active to No for a court that is closed for now. A venue needs at least one active court to be published.'],
  ['body', 'Check fills itself and says OK when the row is complete.'],
  [],
  ['section', 'Not collected here'],
  ['body', 'Hours, photos and session prices: the venue owner adds these in the app after claiming the listing. Write anything useful in Notes; Notes are never imported.'],
  ['body', 'Phone numbers and websites are not shown in the app, so they only go on Permissions.'],
  [],
  ['section', 'Privacy'],
  ['body', 'Permissions holds personal contact details. Keep the filled file private: save it outside git (for example in the ignored venue-data folder in the project) and never share it publicly.'],
  ['body', 'When you hand the file over for import, send a copy with the Permissions sheet deleted. Only Venues and Courts are needed.'],
  [],
  ['section', 'Example (fictional, do not import)'],
  ['body', 'Venues: EX-001 | Sample – Riverside Courts | 12 Example Street, Barangay Uno (not a real venue) | Pasig | Metro Manila | NCR – Metro Manila | 14.5764 | 121.0851 | Owner or manager | Yes'],
  ['body', 'Courts: EX-001 | Court 1 | Hard | No | Yes | Yes'],
  ['body', 'Courts: EX-001 | Court 2 | Synthetic | Yes | Yes | Yes'],
];
const START_WIDTH = 110;
const start = sheetXml({
  selected: true,
  cols: [{ w: START_WIDTH, s: S.body }],
  rows: START.map((line, i) => {
    const [kind, text] = line;
    if (!kind) return { r: i + 1, cells: [] };
    const style = { title: S.title, section: S.section, body: S.body }[kind];
    const ht = kind === 'title' ? 24 : kind === 'section' ? 20 : 15 * Math.ceil(text.length / 100) + 3;
    return { r: i + 1, ht, cells: [{ col: 'A', v: text, s: style }] };
  }).filter((row) => row.cells.length),
});

const lists = sheetXml({
  cols: LISTS.map(() => ({ w: 26 })),
  rows: Array.from({ length: Math.max(...LISTS.map(([, v]) => v.length)) + 1 }, (_, i) => ({
    r: i + 1,
    cells: LISTS.flatMap(([name, values], c) => (i === 0 ? [{ col: letter(c + 1), v: name, s: S.header }] : values[i - 1] ? [{ col: letter(c + 1), v: values[i - 1] }] : [])),
  })),
});

const SHEETS = [['Start here', start], ['Venues', venues], ['Courts', courts], ['Permissions', permissions], ['Lists', lists, 'hidden']];
const NS = 'http://schemas.openxmlformats.org';
const files = [
  ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="${NS}/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${SHEETS.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`],
  ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${NS}/package/2006/relationships"><Relationship Id="rId1" Type="${NS}/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
  ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="${NS}/spreadsheetml/2006/main" xmlns:r="${NS}/officeDocument/2006/relationships"><bookViews><workbookView activeTab="0"/></bookViews><sheets>${SHEETS.map(([name, , state], i) => `<sheet name="${esc(name)}" sheetId="${i + 1}"${state ? ` state="${state}"` : ''} r:id="rId${i + 1}"/>`).join('')}</sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`],
  ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${NS}/package/2006/relationships">${SHEETS.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${NS}/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${SHEETS.length + 1}" Type="${NS}/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
  ['xl/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="${NS}/spreadsheetml/2006/main">`
    + '<numFmts count="2"><numFmt numFmtId="164" formatCode="0.000000"/><numFmt numFmtId="165" formatCode="yyyy-mm-dd"/></numFmts>'
    + '<fonts count="5">'
    + '<font><sz val="11"/><color rgb="FF000000"/><name val="Calibri"/><family val="2"/></font>'
    + '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font>'
    + '<font><b/><sz val="16"/><color rgb="FF1E3F7C"/><name val="Calibri"/><family val="2"/></font>'
    + '<font><b/><sz val="12"/><color rgb="FF1E3F7C"/><name val="Calibri"/><family val="2"/></font>'
    + '<font><sz val="11"/><color rgb="FF334155"/><name val="Calibri"/><family val="2"/></font>'
    + '</fonts>'
    + '<fills count="5"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>'
    + '<fill><patternFill patternType="solid"><fgColor rgb="FF1E3F7C"/><bgColor indexed="64"/></patternFill></fill>'
    + '<fill><patternFill patternType="solid"><fgColor rgb="FFF1F5F9"/><bgColor indexed="64"/></patternFill></fill>'
    + '<fill><patternFill patternType="solid"><fgColor rgb="FF64748B"/><bgColor indexed="64"/></patternFill></fill></fills>'
    + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
    + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
    + '<cellXfs count="10">'
    + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
    + '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>'
    + '<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
    + '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
    + '<xf numFmtId="0" fontId="4" fillId="3" borderId="0" xfId="0" applyFont="1" applyFill="1"/>'
    + '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
    + '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
    + '<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
    + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>'
    + '<xf numFmtId="0" fontId="1" fillId="4" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>'
    + '</cellXfs>'
    + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
    + '<dxfs count="2">'
    + '<dxf><font><color rgb="FF166534"/></font><fill><patternFill><bgColor rgb="FFDCFCE7"/></patternFill></fill></dxf>'
    + '<dxf><font><color rgb="FF92400E"/></font><fill><patternFill><bgColor rgb="FFFEF3C7"/></patternFill></fill></dxf>'
    + '</dxfs><tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/></styleSheet>'],
  ...SHEETS.map(([, xml], i) => [`xl/worksheets/sheet${i + 1}.xml`, xml]),
];

// Minimal zip writer (deflate, fixed 2026-10-13 timestamp so rebuilds are byte-identical).
const DOS_DATE = ((2026 - 1980) << 9) | (10 << 5) | 13;
const locals = []; const centrals = []; let offset = 0;
for (const [name, text] of files) {
  const data = Buffer.from(text, 'utf8');
  const packed = zlib.deflateRawSync(data, { level: 9 });
  const crc = zlib.crc32(data);
  const nameBuf = Buffer.from(name, 'utf8');
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(8, 8);
  local.writeUInt16LE(0, 10); local.writeUInt16LE(DOS_DATE, 12); local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0, 8); central.writeUInt16LE(8, 10);
  central.writeUInt16LE(0, 12); central.writeUInt16LE(DOS_DATE, 14); central.writeUInt32LE(crc, 16); central.writeUInt32LE(packed.length, 20);
  central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBuf.length, 28); central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32);
  central.writeUInt16LE(0, 34); central.writeUInt16LE(0, 36); central.writeUInt32LE(0, 38); central.writeUInt32LE(offset, 42);
  locals.push(local, nameBuf, packed); centrals.push(central, nameBuf);
  offset += local.length + nameBuf.length + packed.length;
}
const cd = Buffer.concat(centrals);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, Buffer.concat([...locals, cd, end]));
console.log(`wrote ${OUT} (${fs.statSync(OUT).size} bytes, ${files.length} parts)`);
