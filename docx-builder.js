// docx-builder.js — assemble le manuel final en .docx : page de garde, sommaire, sections mises en
// forme. Utilise la bibliothèque `docx` (génération programmatique, pas de conversion HTML fragile).
const fs = require('fs');
const path = require('path');
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, PageBreak
} = require('docx');

const NAVY = '0A1B3D';
const GOLD = 'C9A227';

function buildDocxBuffer({ titreManuel, contexte, sections }) {
  const children = [];

  children.push(
    new Paragraph({ text: '', spacing: { before: 2000 } }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: 'TAPA CONSEIL', bold: true, size: 22, color: NAVY })]
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 600 },
      children: [new TextRun({ text: "L'Intelligence Financière Pour Tous", italics: true, size: 18, color: GOLD })]
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 300 },
      children: [new TextRun({ text: titreManuel, bold: true, size: 40, color: NAVY })]
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 800 },
      children: [new TextRun({ text: contexte.nomEntreprise || 'Entreprise non renseignée', size: 26 })]
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: `Document établi le ${new Date().toLocaleDateString('fr-FR')}`, size: 18, color: '6b6455' })]
    }),
    new Paragraph({ children: [new PageBreak()] })
  );

  children.push(
    new Paragraph({ text: 'Sommaire', heading: HeadingLevel.HEADING_1, spacing: { after: 300 } })
  );
  sections.forEach((s, i) => {
    children.push(new Paragraph({ text: `${i + 1}. ${s.titre}`, spacing: { after: 100 } }));
  });
  children.push(new Paragraph({ children: [new PageBreak()] }));

  sections.forEach((s, i) => {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        spacing: { before: 200, after: 200 },
        children: [new TextRun({ text: `${i + 1}. ${s.titre}`, color: NAVY })]
      })
    );
    const paragraphs = (s.contenu || '').split(/\n{2,}/).filter(Boolean);
    paragraphs.forEach(p => {
      children.push(new Paragraph({ text: p.trim(), spacing: { after: 160 }, alignment: AlignmentType.JUSTIFIED }));
    });
  });

  const doc = new Document({
    sections: [{ properties: {}, children }],
    styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } }
  });

  return Packer.toBuffer(doc);
}

async function saveManuelDocx(manuelId, titreManuel, contexte, sections, outDir) {
  const buffer = await buildDocxBuffer({ titreManuel, contexte, sections });
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const filePath = path.join(outDir, `manuel-${manuelId}.docx`);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

module.exports = { buildDocxBuffer, saveManuelDocx };
