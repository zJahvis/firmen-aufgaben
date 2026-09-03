#!/usr/bin/env python3
"""Bereitet das Schrift-CSS auf, damit die Seite nichts von fremden Servern laedt.

Aus dem gelieferten CSS bleiben nur die lateinischen Schnitte uebrig, und in
jedem @font-face verweist src ausschliesslich auf eine lokale woff2-Datei.

    python3 tools/build-fonts.py <eingabe.css> <ausgabe.css>

Auf der Standardausgabe steht anschliessend je Zeile die Quelle der benoetigten
woff2-Datei – bei einer frischen Lieferung die vollstaendige Adresse zum
Herunterladen, bei einem bereits aufbereiteten CSS nur der Dateiname.
"""
import re
import sys

BLOCK = re.compile(r'(?:/\*[^*]*\*/\s*)?@font-face\s*\{[^}]*\}', re.S)
WOFF2 = re.compile(r'url\(\s*["\']?([^"\')]+\.woff2)["\']?\s*\)')
SRC = re.compile(r'(\n\s*src:\s*)[^;]*;', re.S)
KEEP = re.compile(r'-latin(-ext)?-\d+-normal\.woff2$')


def main(src_path, out_path):
    css = open(src_path, encoding='utf-8').read()
    blocks, sources = [], []

    for block in BLOCK.findall(css):
        found = WOFF2.search(block)
        if not found:
            continue
        url = found.group(1)
        name = url.rsplit('/', 1)[-1]
        if not KEEP.search(name):
            continue  # nur lateinische Schnitte, alles andere braucht die Seite nicht
        local = f'url("fonts/{name}") format("woff2")'
        cleaned = SRC.sub(lambda m: f'{m.group(1)}{local};', block, count=1)
        if 'fonts/' + name not in cleaned:
            raise SystemExit(f'src in {name} liess sich nicht ersetzen')
        blocks.append(cleaned.strip())
        sources.append(url)

    if not blocks:
        raise SystemExit('Kein lateinischer Schnitt im gelieferten CSS gefunden.')

    header = (
        '/* Selbst gehostete Schriften: Sora fuer Ueberschriften, Inter fuer den\n'
        '   Fliesstext. Erzeugt von tools/build-fonts.py, nicht von Hand aendern.\n'
        '   Es werden ausschliesslich lokale Dateien geladen. */\n'
    )
    open(out_path, 'w', encoding='utf-8').write(header + '\n' + '\n\n'.join(blocks) + '\n')
    print('\n'.join(sources))


if __name__ == '__main__':
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    main(sys.argv[1], sys.argv[2])
