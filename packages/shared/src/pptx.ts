/**
 * A small PowerPoint writer (design LectureSlides): slides with a title, bullet points and speaker notes, as the
 * files of a .pptx (zip them with any zip library). Text stays editable, unlike decks exported as one picture per
 * slide. Right-to-left text (Hebrew, Arabic) is set right-to-left.
 */

/** One slide. */
export interface DeckSlide { title: string; bullets: string[]; notes?: string }

// Characters XML 1.0 does not allow (control characters but tab, newline and return) are dropped.
const xmlSafe = (s: string) => [...s].filter((c) => { const n = c.charCodeAt(0); return n >= 32 || n === 9 || n === 10 || n === 13; }).join("");
const esc = (s: string) => xmlSafe(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const rtl = (s: string) => /[֐-ࣿ]/.test(s);
const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const W = 12192000;
const H = 6858000;

const para = (text: string, o: { size: number; bold?: boolean; bullet?: boolean; color?: string }) => {
  const r = rtl(text);
  const pPr = `<a:pPr${r ? ' rtl="1" algn="r"' : ""}${o.bullet ? ` marL="342900" indent="-342900"` : ""}>${o.bullet ? '<a:spcBef><a:spcPts val="1400"/></a:spcBef><a:buFont typeface="Arial"/><a:buChar char="•"/>' : "<a:buNone/>"}</a:pPr>`;
  return `<a:p>${pPr}<a:r><a:rPr lang="${r ? "he-IL" : "en-US"}" sz="${o.size}"${o.bold ? ' b="1"' : ""} dirty="0"><a:solidFill><a:srgbClr val="${o.color ?? "FFFFFF"}"/></a:solidFill></a:rPr><a:t>${esc(text)}</a:t></a:r></a:p>`;
};

const box = (id: number, name: string, x: number, y: number, w: number, h: number, body: string) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr wrap="square" anchor="t"/><a:lstStyle/>${body}</p:txBody></p:sp>`;

const tree = (shapes: string) =>
  `<p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="1B2140"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${shapes}</p:spTree></p:cSld>`;

const THEME = (name: string) =>
  `${HEAD}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="${name}"><a:themeElements><a:clrScheme name="KesherAI"><a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1B2140"/></a:dk2><a:lt2><a:srgbClr val="E7E9F5"/></a:lt2><a:accent1><a:srgbClr val="A5B4FF"/></a:accent1><a:accent2><a:srgbClr val="7FD8A8"/></a:accent2><a:accent3><a:srgbClr val="F0A830"/></a:accent3><a:accent4><a:srgbClr val="FF7A7A"/></a:accent4><a:accent5><a:srgbClr val="C792EA"/></a:accent5><a:accent6><a:srgbClr val="5FD3F3"/></a:accent6><a:hlink><a:srgbClr val="A5B4FF"/></a:hlink><a:folHlink><a:srgbClr val="C792EA"/></a:folHlink></a:clrScheme><a:fontScheme name="KesherAI"><a:majorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface="Arial"/></a:majorFont><a:minorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface="Arial"/></a:minorFont></a:fontScheme><a:fmtScheme name="KesherAI"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`;

/**
 * The files of a .pptx (path → text), slides 16:9.
 *
 * @param title - The deck's title (its first slide).
 * @param slides - The slides.
 */
export function pptxFiles(title: string, slides: DeckSlide[]): Record<string, string> {
  const all: DeckSlide[] = [{ title, bullets: [] }, ...slides];
  const f: Record<string, string> = {};
  const n = all.length;
  f["[Content_Types].xml"] = `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/notesMasters/notesMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/><Override PartName="/ppt/theme/theme2.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>${all.map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/><Override PartName="/ppt/notesSlides/notesSlide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>`).join("")}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`;
  f["_rels/.rels"] = `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="ppt/presentation.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="${REL}/extended-properties" Target="docProps/app.xml"/></Relationships>`;
  f["docProps/core.xml"] = `${HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${esc(title)}</dc:title><dc:creator>KesherAI</dc:creator></cp:coreProperties>`;
  f["docProps/app.xml"] = `${HEAD}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>KesherAI</Application><Slides>${n}</Slides></Properties>`;
  f["ppt/presentation.xml"] = `${HEAD}<p:presentation ${NS} saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:notesMasterIdLst><p:notesMasterId r:id="rId2"/></p:notesMasterIdLst><p:sldIdLst>${all.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${10 + i}"/>`).join("")}</p:sldIdLst><p:sldSz cx="${W}" cy="${H}"/><p:notesSz cx="6858000" cy="9144000"/><p:defaultTextStyle><a:defPPr><a:defRPr lang="en-US"/></a:defPPr></p:defaultTextStyle></p:presentation>`;
  f["ppt/_rels/presentation.xml.rels"] = `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/slideMaster" Target="slideMasters/slideMaster1.xml"/><Relationship Id="rId2" Type="${REL}/notesMaster" Target="notesMasters/notesMaster1.xml"/><Relationship Id="rId3" Type="${REL}/theme" Target="theme/theme1.xml"/>${all.map((_, i) => `<Relationship Id="rId${10 + i}" Type="${REL}/slide" Target="slides/slide${i + 1}.xml"/>`).join("")}</Relationships>`;
  f["ppt/theme/theme1.xml"] = THEME("KesherAI");
  f["ppt/theme/theme2.xml"] = THEME("KesherAI Notes");
  const emptyTree = tree("");
  const txStyles = `<p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz="4000"/></a:lvl1pPr></p:titleStyle><p:bodyStyle><a:lvl1pPr><a:defRPr sz="2400"/></a:lvl1pPr></p:bodyStyle><p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle></p:txStyles>`;
  f["ppt/slideMasters/slideMaster1.xml"] = `${HEAD}<p:sldMaster ${NS}>${emptyTree}<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>${txStyles}</p:sldMaster>`;
  f["ppt/slideMasters/_rels/slideMaster1.xml.rels"] = `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="${REL}/theme" Target="../theme/theme1.xml"/></Relationships>`;
  f["ppt/slideLayouts/slideLayout1.xml"] = `${HEAD}<p:sldLayout ${NS} type="blank" preserve="1"><p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;
  f["ppt/slideLayouts/_rels/slideLayout1.xml.rels"] = `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`;
  f["ppt/notesMasters/notesMaster1.xml"] = `${HEAD}<p:notesMaster ${NS}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/></p:notesMaster>`;
  f["ppt/notesMasters/_rels/notesMaster1.xml.rels"] = `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/theme" Target="../theme/theme2.xml"/></Relationships>`;
  all.forEach((s, i) => {
    const k = i + 1;
    const first = i === 0;
    const shapes = first
      ? box(2, "Title", 685800, 2286000, W - 1371600, 1600200, para(s.title, { size: 4400, bold: true })) + box(3, "Subtitle", 685800, 3962400, W - 1371600, 762000, para("KesherAI", { size: 2000, color: "A5B4FF" }))
      : box(2, "Title", 609600, 457200, W - 1219200, 1143000, para(s.title, { size: 3600, bold: true })) + box(3, "Body", 609600, 1752600, W - 1219200, H - 2362200, s.bullets.map((b) => para(b, { size: 2400, bullet: true })).join("") || para("", { size: 2400 }));
    f[`ppt/slides/slide${k}.xml`] = `${HEAD}<p:sld ${NS}>${tree(shapes)}<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
    f[`ppt/slides/_rels/slide${k}.xml.rels`] = `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="${REL}/notesSlide" Target="../notesSlides/notesSlide${k}.xml"/></Relationships>`;
    const notes = (s.notes ?? "").trim();
    const nr = rtl(notes);
    f[`ppt/notesSlides/notesSlide${k}.xml`] = `${HEAD}<p:notes ${NS}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p>${nr ? '<a:pPr rtl="1" algn="r"/>' : ""}<a:r><a:rPr lang="${nr ? "he-IL" : "en-US"}" dirty="0"/><a:t>${esc(notes)}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>`;
    f[`ppt/notesSlides/_rels/notesSlide${k}.xml.rels`] = `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/notesMaster" Target="../notesMasters/notesMaster1.xml"/><Relationship Id="rId2" Type="${REL}/slide" Target="../slides/slide${k}.xml"/></Relationships>`;
  });
  return f;
}
