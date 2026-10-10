import { Document, Packer, Paragraph, TextRun, HeadingLevel } from "docx";

export function articlesToText(articles) {
  return articles
    .map(
      (a) =>
        `${a.title}\n${a.source} | ${a.publishedAt ? new Date(a.publishedAt).toLocaleDateString("ar") : "تاريخ غير متاح"}\n\n${(a.summary || []).join("\n")}\n\nالمصدر: ${a.url}`,
    )
    .join("\n\n────────────────────────\n\n");
}
function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
export function exportTxt(articles) {
  download(
    new Blob(["\ufeff", articlesToText(articles)], {
      type: "text/plain;charset=utf-8",
    }),
    "موجز.txt",
  );
}
export async function exportDocx(articles) {
  const paragraph = (text, heading) =>
    new Paragraph({
      bidirectional: true,
      heading,
      children: [
        new TextRun({ text, rightToLeft: true, font: "Arial", size: 24 }),
      ],
      spacing: { after: 160 },
    });
  const doc = new Document({
    sections: [
      {
        properties: {},
        children: [
          paragraph("موجز — مفكرتي الإخبارية", HeadingLevel.TITLE),
          ...articles.flatMap((a) => [
            paragraph(a.title, HeadingLevel.HEADING_1),
            paragraph(a.source),
            ...(a.summary || []).map((s) => paragraph(s)),
            paragraph(a.url),
          ]),
        ],
      },
    ],
  });
  download(await Packer.toBlob(doc), "موجز.docx");
}
export function exportPdf(articles) {
  const area = document.querySelector("#print-area");
  area.replaceChildren();
  const title = document.createElement("h1");
  title.textContent = "موجز — مفكرتي الإخبارية";
  area.append(title);
  for (const article of articles) {
    const section = document.createElement("section");
    const h = document.createElement("h2");
    h.textContent = article.title;
    section.append(h);
    for (const text of [
      article.source,
      ...(article.summary || []),
      article.url,
    ]) {
      const p = document.createElement("p");
      p.textContent = text;
      section.append(p);
    }
    area.append(section);
  }
  window.print();
}
