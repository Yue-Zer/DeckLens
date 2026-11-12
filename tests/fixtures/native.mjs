import JSZip from 'jszip';
import { PDFDocument, PDFName, PDFString, PDFNumber, PDFHexString, StandardFonts } from 'pdf-lib';

export const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64');

export async function pdfFixture({ pages = 2, outline = true, scan = false, encrypted = false } = {}) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const image = await pdf.embedPng(pixel);
  for (let index = 0; index < pages; index++) {
    const page = pdf.addPage([480, 400]);
    if (!scan) {
      page.drawText(index === 0 ? 'Native PDF chapter' : 'Native PDF subsection ' + (index + 1), { x: 48, y: 350, size: 20, font });
      page.drawText('Evidence means an exact passage retained with its source location.', { x: 48, y: 300, size: 10, font });
      page.drawText('Evidence supports local reading on page ' + (index + 1) + '.', { x: 48, y: 270, size: 10, font });
    }
    page.drawImage(image, { x: 48, y: 180, width: 36, height: 36 });
  }
  if (outline) {
    const root = pdf.context.obj({ Type: 'Outlines' });
    const rootRef = pdf.context.register(root);
    const first = pdf.context.obj({ Title: PDFString.of('Native PDF chapter'), Parent: rootRef, Dest: [pdf.getPages()[0].ref, PDFName.of('Fit')] });
    const firstRef = pdf.context.register(first);
    root.set(PDFName.of('First'), firstRef);
    root.set(PDFName.of('Last'), firstRef);
    root.set(PDFName.of('Count'), PDFNumber.of(1));
    if (pages > 1) {
      const sub = pdf.context.obj({ Title: PDFString.of('Native PDF subsection 2'), Parent: firstRef, Dest: [pdf.getPages()[1].ref, PDFName.of('Fit')] });
      const subRef = pdf.context.register(sub);
      first.set(PDFName.of('First'), subRef);
      first.set(PDFName.of('Last'), subRef);
      first.set(PDFName.of('Count'), PDFNumber.of(1));
      root.set(PDFName.of('Count'), PDFNumber.of(2));
    }
    pdf.catalog.set(PDFName.of('Outlines'), rootRef);
  }
  if (encrypted) {
    // A password-required envelope; content need not be decrypted in refusal tests.
    const encryption = pdf.context.obj({ Filter: 'Standard', V: 1, R: 2, Length: 40,
      O: PDFHexString.of('00'.repeat(32)), U: PDFHexString.of('00'.repeat(32)), P: -4 });
    pdf.context.trailerInfo.Encrypt = pdf.context.register(encryption);
    pdf.context.trailerInfo.ID = pdf.context.obj([PDFHexString.of('11'.repeat(16)), PDFHexString.of('11'.repeat(16))]);
  }
  return Buffer.from(await pdf.save({ useObjectStreams: false }));
}

function largeBitmap() {
  const width = 3072, height = 3072;
  const image = Buffer.alloc(54 + width * height * 3);
  image.write('BM'); image.writeUInt32LE(image.length, 2); image.writeUInt32LE(54, 10);
  image.writeUInt32LE(40, 14); image.writeInt32LE(width, 18); image.writeInt32LE(height, 22);
  image.writeUInt16LE(1, 26); image.writeUInt16LE(24, 28); image.writeUInt32LE(width * height * 3, 34);
  for (let i = 54; i < image.length; i++) image[i] = (i * 31 + (i >>> 8)) & 255;
  return image;
}

export async function docxFixture({ large = false, brokenNotes = false } = {}) {
  const zip = new JSZip();
  const extension = large ? 'bmp' : 'png';
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="' + extension + '" ContentType="image/' + extension + '"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="document" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/styles.xml', '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr></w:style><w:style w:type="character" w:styleId="Code"><w:name w:val="Code"/></w:style></w:styles>');
  zip.file('word/numbering.xml', '<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum><w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>');
  zip.file('word/_rels/document.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="image" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/figure.' + extension + '"/><Relationship Id="footnotes" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/></Relationships>');
  zip.file('word/media/figure.' + extension, large ? largeBitmap() : pixel);
  const heading = (level, value) => '<w:p><w:pPr><w:pStyle w:val="Heading' + level + '"/></w:pPr><w:r><w:t>' + value + '</w:t></w:r></w:p>';
  const list = (id, value) => '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="' + id + '"/></w:numPr></w:pPr><w:r><w:t>' + value + '</w:t></w:r></w:p>';
  const body = heading(1, 'Native DOCX chapter') + heading(2, 'Native DOCX subsection') +
    '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Evidence</w:t></w:r><w:r><w:t> means an exact passage retained with its source location.</w:t></w:r><w:r><w:footnoteReference w:id="1"/></w:r></w:p>' +
    '<w:p><w:r><w:rPr><w:i/></w:rPr><w:t>Italic text</w:t></w:r><w:r><w:t> and </w:t></w:r><w:r><w:rPr><w:rStyle w:val="Code"/></w:rPr><w:t>localCode()</w:t></w:r></w:p>' +
    list(1, 'First ordered item') + list(1, 'Second ordered item') + list(2, 'Unordered item') +
    '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Column A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Column B</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>Value A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Value B</w:t></w:r></w:p></w:tc></w:tr></w:tbl>' +
    '<w:p><w:r><w:t>Before image</w:t></w:r><w:r><w:drawing><wp:inline><wp:docPr id="1" name="Figure" descr="Local figure"/><a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="image"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r><w:r><w:t>After image</w:t></w:r></w:p>';
  zip.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>' + body + '<w:sectPr/></w:body></w:document>');
  zip.file('word/footnotes.xml', brokenNotes ? '<broken>' : '<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:footnote w:id="1"><w:p><w:r><w:t>Locally retained footnote.</w:t></w:r></w:p></w:footnote></w:footnotes>');
  // STORE keeps the large-image performance fixture genuinely tens of MiB on disk.
  return zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
}
