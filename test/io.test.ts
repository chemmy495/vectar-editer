import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseXml, findAll, escapeXml, decodeEntities, element } from '../src/core/io/xml.ts';
import { importSvg, parseLength } from '../src/core/io/svg/import.ts';
import { exportSvg } from '../src/core/io/svg/export.ts';
import { exportPdf } from '../src/core/io/pdf/export.ts';
import { serializeDocument, parseDocument, cloneDocument } from '../src/core/io/vectar.ts';
import { createDocument } from '../src/core/model/document.ts';
import { createPathNode, createTextNode, createGroupNode } from '../src/core/model/node.ts';
import { defaultFill, defaultStroke, solidPaint } from '../src/core/model/style.ts';
import { rectanglePath, ellipsePath } from '../src/core/path/shapes.ts';
import { rect } from '../src/core/geometry/rect.ts';
import { translation, scaling } from '../src/core/geometry/matrix.ts';
import * as query from '../src/core/model/query.ts';
import * as P from '../src/core/path/path.ts';

const close = (a: number, b: number, eps = 1e-6) =>
  assert.ok(Math.abs(a - b) <= eps, `expected ${a} ~= ${b}`);

const text = (bytes: Uint8Array) => Buffer.from(bytes).toString('latin1');

test('xml parser reads elements, attributes and nesting', () => {
  const root = parseXml('<a x="1"><b y="2"/><b y="3">hi</b></a>')!;
  assert.equal(root.name, 'a');
  assert.equal(root.attributes.x, '1');
  assert.equal(root.children.length, 2);
  assert.equal(root.children[1].text, 'hi');
});

test('xml parser handles declarations, comments, CDATA and entities', () => {
  const root = parseXml(`<?xml version="1.0"?><!-- note --><r a="a&amp;b"><![CDATA[<raw>]]>&lt;ok&gt;</r>`)!;
  assert.equal(root.name, 'r');
  assert.equal(root.attributes.a, 'a&b');
  assert.equal(root.text, '<raw><ok>');
});

test('xml parser strips the svg namespace prefix but keeps xlink', () => {
  const root = parseXml('<svg:svg xmlns:svg="x"><svg:path xlink:href="#a" d="M0 0"/></svg:svg>')!;
  assert.equal(root.name, 'svg');
  assert.equal(root.children[0].name, 'path');
  assert.equal(root.children[0].attributes['xlink:href'], '#a');
});

test('xml parser tolerates unquoted attributes and stray junk', () => {
  const root = parseXml('<a b=1 c="2">x</a>')!;
  assert.equal(root.attributes.b, '1');
  assert.equal(root.attributes.c, '2');
  assert.equal(parseXml(''), null);
  assert.equal(parseXml('not xml at all'), null);
});

test('xml escaping round-trips', () => {
  const raw = `a & b < c > d " e ' f`;
  assert.equal(decodeEntities(escapeXml(raw)), raw);
  assert.equal(element('t', { a: 1, b: undefined }, 'x'), '<t a="1">x</t>');
  assert.equal(element('t', {}), '<t/>');
});

test('parseLength understands units and percentages', () => {
  close(parseLength('10'), 10);
  close(parseLength('10px'), 10);
  close(parseLength('1in'), 96);
  close(parseLength('72pt'), 96);
  close(parseLength('25.4mm'), 96);
  close(parseLength('50%', 200), 100);
  close(parseLength(undefined), 0);
});

test('importSvg reads canvas size and basic shapes', () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100">
    <rect x="10" y="10" width="50" height="30" fill="#ff0000"/>
    <circle cx="100" cy="50" r="20" fill="blue"/>
  </svg>`;
  const { document } = importSvg(svg);
  assert.equal(document.width, 200);
  assert.equal(document.height, 100);
  const nodes = query.allNodes(document).filter((n) => n.type === 'path');
  assert.equal(nodes.length, 2);
  const rectNode = nodes[0];
  assert.ok(rectNode.type === 'path' && rectNode.fill.paint.type === 'solid');
  assert.deepEqual((rectNode as any).fill.paint.color, { r: 255, g: 0, b: 0, a: 1 });
  assert.deepEqual(P.bounds((rectNode as any).path), rect(10, 10, 50, 30));
});

test('importSvg applies the viewBox as a transform', () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 100 100">
    <rect x="0" y="0" width="50" height="50"/></svg>`;
  const { document } = importSvg(svg);
  const node = query.allNodes(document).find((n) => n.type === 'path')!;
  const bounds = query.worldBounds(node, query.parentTransform(document, node.id))!;
  close(bounds.width, 100); // 50 units scaled 2x
});

test('importSvg inherits style down groups and honours inline style', () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">
    <g fill="#00ff00" stroke="#000" stroke-width="4">
      <rect width="10" height="10"/>
      <rect width="10" height="10" style="fill:#0000ff;fill-opacity:0.5"/>
    </g></svg>`;
  const { document } = importSvg(svg);
  const paths = query.allNodes(document).filter((n) => n.type === 'path') as any[];
  assert.deepEqual(paths[0].fill.paint.color, { r: 0, g: 255, b: 0, a: 1 });
  assert.equal(paths[0].stroke.width, 4);
  assert.deepEqual(paths[1].fill.paint.color, { r: 0, g: 0, b: 255, a: 0.5 });
});

test('importSvg resolves gradient fills', () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">
    <defs><linearGradient id="g" x1="0" y1="0" x2="100" y2="0">
      <stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff"/>
    </linearGradient></defs>
    <rect width="100" height="100" fill="url(#g)"/></svg>`;
  const { document } = importSvg(svg);
  const node = query.allNodes(document).find((n) => n.type === 'path') as any;
  assert.equal(node.fill.paint.type, 'linear');
  assert.equal(node.fill.paint.stops.length, 2);
  assert.deepEqual(node.fill.paint.stops[1].color, { r: 0, g: 0, b: 255, a: 1 });
});

test('importSvg reads transforms, text and opacity', () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">
    <g transform="translate(10 20)" opacity="0.4">
      <text x="5" y="30" font-size="18" font-family="Arial" text-anchor="middle">Hello</text>
    </g></svg>`;
  const { document } = importSvg(svg);
  const group = query.allNodes(document).find((n) => n.type === 'group')!;
  close(group.transform.e, 10);
  close(group.opacity, 0.4);
  const textNode = query.allNodes(document).find((n) => n.type === 'text') as any;
  assert.equal(textNode.text, 'Hello');
  assert.equal(textNode.fontSize, 18);
  assert.equal(textNode.align, 'middle');
});

test('importSvg reports what it skipped', () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">
    <defs><clipPath id="c"><rect width="5" height="5"/></clipPath></defs>
    <rect width="10" height="10" clip-path="url(#c)"/></svg>`;
  const { warnings } = importSvg(svg);
  assert.ok(warnings.some((w) => /clip/i.test(w)));
});

test('importSvg rejects non-SVG input gracefully', () => {
  const { warnings } = importSvg('<html><body/></html>');
  assert.ok(warnings.length > 0);
});

test('exportSvg writes a well-formed document that re-imports', () => {
  const doc = createDocument(300, 200, 'Test');
  const node = createPathNode(rectanglePath(rect(20, 30, 100, 60)), 'Box');
  node.fill = defaultFill({ r: 10, g: 200, b: 30, a: 1 });
  node.stroke = defaultStroke({ r: 0, g: 0, b: 0, a: 1 }, 3);
  node.transform = translation(5, 5);
  doc.layers[0].children.push(node);

  const svg = exportSvg(doc);
  assert.match(svg, /<svg[^>]*width="300"/);
  assert.match(svg, /viewBox="0 0 300 200"/);

  const round = importSvg(svg).document;
  assert.equal(round.width, 300);
  // The first path is the exported background rectangle; find the shape by name.
  const imported = query.allNodes(round).find((n) => n.name === 'Box')!;
  assert.ok(imported, 'the node name should survive the round trip');
  const bounds = query.worldBounds(imported, query.parentTransform(round, imported.id))!;
  close(bounds.x, 20 + 5 - 1.5, 0.01); // offset by the transform, grown by the stroke
  close(bounds.width, 100 + 3, 0.01);
});

test('exportSvg emits gradients into defs', () => {
  const doc = createDocument(100, 100);
  const node = createPathNode(ellipsePath(rect(0, 0, 100, 100)));
  node.fill = {
    rule: 'nonzero',
    paint: {
      type: 'linear',
      from: { x: 0, y: 0 },
      to: { x: 100, y: 0 },
      stops: [
        { offset: 0, color: { r: 255, g: 0, b: 0, a: 1 } },
        { offset: 1, color: { r: 0, g: 0, b: 255, a: 0.5 } },
      ],
    },
  };
  doc.layers[0].children.push(node);
  const svg = exportSvg(doc);
  assert.match(svg, /<linearGradient/);
  assert.match(svg, /stop-opacity="0.5"/);
  assert.match(svg, /fill="url\(#grad1\)"/);
  const parsed = parseXml(svg)!;
  assert.equal(findAll(parsed, 'linearGradient').length, 1);
});

test('exportSvg writes text with tspans per line', () => {
  const doc = createDocument(100, 100);
  const node = createTextNode('one\ntwo', 10, 20);
  doc.layers[0].children.push(node);
  const svg = exportSvg(doc);
  const parsed = parseXml(svg)!;
  assert.equal(findAll(parsed, 'tspan').length, 2);
  assert.equal(findAll(parsed, 'text')[0].attributes['font-size'], '24');
});

test('exportSvg honours hidden nodes and the only filter', () => {
  const doc = createDocument(100, 100);
  const visible = createPathNode(rectanglePath(rect(0, 0, 10, 10)), 'visible');
  const hidden = createPathNode(rectanglePath(rect(20, 0, 10, 10)), 'hidden');
  hidden.visible = false;
  doc.layers[0].children.push(visible, hidden);
  assert.match(exportSvg(doc), /display="none"/);

  const filtered = exportSvg(doc, { only: new Set([visible.id]) });
  const paths = findAll(parseXml(filtered)!, 'path');
  assert.equal(paths.length, 1);
  assert.equal(paths[0].attributes['data-name'], 'visible');
});

test('exportSvg nests groups', () => {
  const doc = createDocument(100, 100);
  const inner = createPathNode(rectanglePath(rect(0, 0, 10, 10)));
  const group = createGroupNode([inner], 'G');
  group.transform = scaling(2);
  doc.layers[0].children.push(group);
  const parsed = parseXml(exportSvg(doc))!;
  const groups = findAll(parsed, 'g');
  assert.ok(groups.length >= 2); // layer plus the group
  assert.ok(groups.some((g) => /matrix\(2/.test(g.attributes.transform ?? '')));
});

test('exportPdf produces a parseable single-page PDF', () => {
  const doc = createDocument(200, 100, 'PDF');
  const node = createPathNode(rectanglePath(rect(10, 10, 50, 50)));
  node.fill = defaultFill({ r: 255, g: 0, b: 0, a: 1 });
  doc.layers[0].children.push(node);
  const body = text(exportPdf(doc));

  assert.ok(body.startsWith('%PDF-1.4'));
  assert.ok(body.trimEnd().endsWith('%%EOF'));
  assert.match(body, /\/MediaBox \[0 0 200 100\]/);
  assert.match(body, /\/Type \/Catalog/);
  assert.match(body, /1 0 0 rg/); // pure red fill
  assert.match(body, /\bre f\b/); // background rectangle
});

test('pdf xref offsets point at their objects', () => {
  const doc = createDocument(100, 100);
  doc.layers[0].children.push(createTextNode('Hi', 10, 20));
  const body = text(exportPdf(doc));

  const xrefIndex = /startxref\n(\d+)/.exec(body);
  assert.ok(xrefIndex);
  assert.equal(body.slice(Number(xrefIndex![1]), Number(xrefIndex![1]) + 4), 'xref');

  const entries = [...body.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
  assert.ok(entries.length >= 4);
  entries.forEach((offset, index) => {
    assert.match(body.slice(offset, offset + 12), new RegExp(`^${index + 1} 0 obj`));
  });
});

test('pdf embeds a font for text and picks a standard base font', () => {
  const doc = createDocument(100, 100);
  const node = createTextNode('Hello', 10, 20);
  node.fontFamily = 'Times New Roman';
  node.fontWeight = 700;
  doc.layers[0].children.push(node);
  const body = text(exportPdf(doc));
  assert.match(body, /\/BaseFont \/Times-Bold/);
  assert.match(body, /\(Hello\) Tj/);
});

test('pdf escapes parentheses in text', () => {
  const doc = createDocument(100, 100);
  doc.layers[0].children.push(createTextNode('a(b)c\\d', 0, 10));
  assert.match(text(exportPdf(doc)), /\(a\\\(b\\\)c\\\\d\) Tj/);
});

test('pdf records translucency as an ExtGState', () => {
  const doc = createDocument(100, 100);
  const node = createPathNode(rectanglePath(rect(0, 0, 10, 10)));
  node.fill = { rule: 'nonzero', paint: solidPaint({ r: 0, g: 0, b: 0, a: 0.25 }) };
  doc.layers[0].children.push(node);
  const body = text(exportPdf(doc));
  assert.match(body, /\/ca 0.25/);
  assert.match(body, /\/GS1 gs/);
});

test('pdf honours the points-per-pixel scale', () => {
  const doc = createDocument(200, 100);
  const body = text(exportPdf(doc, { pointsPerPixel: 0.75 }));
  assert.match(body, /\/MediaBox \[0 0 150 75\]/);
});

test('native format round-trips a document', () => {
  const doc = createDocument(640, 480, 'Native');
  doc.background = { r: 12, g: 34, b: 56, a: 1 };
  const node = createPathNode(rectanglePath(rect(1, 2, 3, 4)), 'R');
  node.transform = translation(7, 8);
  node.opacity = 0.25;
  doc.layers[0].children.push(node, createTextNode('hi', 1, 2));

  const { document: round, warnings } = parseDocument(serializeDocument(doc, true));
  assert.deepEqual(warnings, []);
  assert.equal(round.width, 640);
  assert.equal(round.name, 'Native');
  assert.deepEqual(round.background, { r: 12, g: 34, b: 56, a: 1 });
  const restored = query.allNodes(round).find((n) => n.name === 'R')!;
  assert.equal(restored.opacity, 0.25);
  assert.deepEqual(restored.transform, translation(7, 8));
  assert.deepEqual(P.bounds((restored as any).path), rect(1, 2, 3, 4));
});

test('native format rejects foreign files without throwing', () => {
  assert.ok(parseDocument('{}').warnings.length > 0);
  assert.ok(parseDocument('not json').warnings[0].includes('not valid JSON'));
  assert.ok(parseDocument('{"format":"vectar","layers":"bad"}').warnings.length > 0);
});

test('cloneDocument makes an independent copy', () => {
  const doc = createDocument(100, 100);
  doc.layers[0].children.push(createPathNode(rectanglePath(rect(0, 0, 5, 5)), 'A'));
  const copy = cloneDocument(doc);
  copy.layers[0].children[0].name = 'B';
  copy.layers[0].children.push(createPathNode());
  assert.equal(doc.layers[0].children[0].name, 'A');
  assert.equal(doc.layers[0].children.length, 1);
});

test('an entity above the Unicode maximum is left alone, not thrown on', () => {
  // Regression: String.fromCodePoint threw a RangeError and aborted the import.
  assert.equal(decodeEntities('a&#x110000;b'), 'a&#x110000;b');
  assert.equal(decodeEntities('a&#99999999;b'), 'a&#99999999;b');
  assert.equal(decodeEntities('a&#65;b'), 'aAb');
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">'
    + '<path d="M0 0 L5 5" id="a&#x110000;b"/></svg>';
  const { document } = importSvg(svg);
  assert.equal(query.allNodes(document).filter((n) => n.type === 'path').length, 1);
});

test('presentation attributes on the root svg are inherited', () => {
  // Regression: icon sets put fill/stroke on <svg> itself, and ignoring them
  // imported every icon as a solid black blob.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"
    fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 12h14"/></svg>`;
  const node = query.allNodes(importSvg(svg).document).find((n) => n.type === 'path') as any;
  assert.equal(node.fill.paint.type, 'none');
  assert.equal(node.stroke.paint.type, 'solid');
  assert.equal(node.stroke.width, 2);
  assert.equal(node.stroke.cap, 'round');
});

test('preserveAspectRatio defaults to uniform scaling and centring', () => {
  // Regression: the default stretched the artwork to fill the viewport.
  const circle = '<circle cx="50" cy="50" r="50"/>';
  const fit = importSvg(`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 100 100">${circle}</svg>`).document;
  const node = query.allNodes(fit).find((n) => n.type === 'path')!;
  const bounds = query.worldBounds(node, query.parentTransform(fit, node.id))!;
  close(bounds.width, 100, 0.01);
  close(bounds.height, 100, 0.01);
  close(bounds.x, 50, 0.01); // centred in the 200-wide viewport

  // `none` is the one value that stretches.
  const stretched = importSvg(`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 100 100" preserveAspectRatio="none">${circle}</svg>`).document;
  const stretchedNode = query.allNodes(stretched).find((n) => n.type === 'path')!;
  const stretchedBounds = query.worldBounds(stretchedNode, query.parentTransform(stretched, stretchedNode.id))!;
  close(stretchedBounds.width, 200, 0.01);

  // xMinYMin pins to the top-left instead of centring.
  const pinned = importSvg(`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 100 100" preserveAspectRatio="xMinYMin meet">${circle}</svg>`).document;
  const pinnedNode = query.allNodes(pinned).find((n) => n.type === 'path')!;
  close(query.worldBounds(pinnedNode, query.parentTransform(pinned, pinnedNode.id))!.x, 0, 0.01);
});

test('gradients default to object bounding box units', () => {
  // Regression: the default unit was read as user space, so a gradient
  // finished within the first 100px of whatever it filled.
  const gradient = `<defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/>
    <stop offset="1" stop-color="#00f"/></linearGradient></defs>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="100">${gradient}
    <rect x="0" y="0" width="400" height="100" fill="url(#g)"/></svg>`;
  const node = query.allNodes(importSvg(svg).document).find((n) => n.type === 'path') as any;
  assert.equal(node.fill.paint.type, 'linear');
  close(node.fill.paint.from.x, 0, 0.01);
  close(node.fill.paint.to.x, 400, 0.01);

  // A shape offset from the origin gets the gradient over its own box.
  const offset = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="100">${gradient}
    <rect x="100" y="0" width="200" height="100" fill="url(#g)"/></svg>`;
  const offsetNode = query.allNodes(importSvg(offset).document).find((n) => n.type === 'path') as any;
  close(offsetNode.fill.paint.from.x, 100, 0.01);
  close(offsetNode.fill.paint.to.x, 300, 0.01);
});

test('userSpaceOnUse gradients keep their authored coordinates', () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="100">
    <defs><linearGradient id="g" gradientUnits="userSpaceOnUse" x1="10" y1="0" x2="60" y2="0">
      <stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/>
    </linearGradient></defs>
    <rect x="0" y="0" width="400" height="100" fill="url(#g)"/></svg>`;
  const node = query.allNodes(importSvg(svg).document).find((n) => n.type === 'path') as any;
  close(node.fill.paint.from.x, 10, 0.01);
  close(node.fill.paint.to.x, 60, 0.01);
});

test('a .vectar file with malformed objects loads without crashing', () => {
  // Regression: node contents were trusted wholesale, so a path with no
  // geometry parsed with no warning and then threw when measured.
  const broken = JSON.stringify({
    format: 'vectar', version: 1, name: 'broken', width: 100, height: 100,
    layers: [{
      type: 'layer', id: 'L', name: 'L', children: [
        { type: 'path', id: 'a', name: 'no geometry' },
        { type: 'path', id: 'b', name: 'bad geometry', path: { subpaths: 'nope' } },
        { type: 'image', id: 'c', name: 'no href' },
        { type: 'nonsense', id: 'd' },
        { type: 'path', id: 'e', name: 'fine', path: { subpaths: [{ closed: true, anchors: [
          { point: { x: 0, y: 0 } }, { point: { x: 10, y: 0 } }, { point: { x: 10, y: 10 } },
        ] }] } },
      ],
    }],
  });
  const { document, warnings } = parseDocument(broken);
  assert.ok(warnings.some((w) => /could not be read/.test(w)), `expected a warning, got ${JSON.stringify(warnings)}`);

  const paths = query.allNodes(document).filter((n) => n.type === 'path');
  assert.equal(paths.length, 1, 'only the usable path should survive');
  assert.equal(paths[0].name, 'fine');
  // Every surviving node must be safe to measure and serialize.
  for (const node of query.allNodes(document)) {
    assert.doesNotThrow(() => query.localBounds(node));
  }
  assert.doesNotThrow(() => exportSvg(document));
});

test('.vectar defaults fill in missing style and rejects a bogus blend mode', () => {
  const partial = JSON.stringify({
    format: 'vectar', version: 1, name: 'x', width: 10, height: 10,
    layers: [{ type: 'layer', id: 'L', name: 'L', blendMode: 'not-a-mode', children: [
      { type: 'path', id: 'p', name: 'p', path: { subpaths: [{ closed: false, anchors: [
        { point: { x: 0, y: 0 } }, { point: { x: 5, y: 5 } },
      ] }] } },
    ] }],
  });
  const { document } = parseDocument(partial);
  assert.equal(document.layers[0].blendMode, 'normal');
  const node = query.allNodes(document).find((n) => n.type === 'path') as any;
  assert.equal(node.stroke.width, 1);
  assert.deepEqual(node.stroke.dash, []);
  assert.equal(node.fill.rule, 'nonzero');
});
