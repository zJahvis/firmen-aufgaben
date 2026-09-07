# Firmen-Aufgaben

Gemeinsame Aufgaben-Pinnwand für zwei Personen mit den drei Spalten
**Offen · Dran · Erledigt** – komplett auf Deutsch, mobiltauglich, PIN-geschützt
und ohne einen einzigen kostenpflichtigen Dienst.

* **Der Kollege** legt Aufgaben an (Titel + optionaler Link).
* **JAHVIS** arbeitet sie ab, schreibt Notizen dazu und hakt sie ab.
* Beide sehen dieselbe Pinnwand, auf jedem Gerät, in Echtzeit (Abgleich alle 10 Sekunden).

Jede Aufgabe hat eine **Wichtigkeit** (*Hoch* / *Mittel* / *Niedrig*), optional eine
**Frist**, eine **Zuständigkeit**, zwei getrennte **Links** und einen
**Kommentarverlauf**.

---

## Wie es aufgebaut ist

| Teil | Umsetzung |
|---|---|
| Oberfläche | Statische Seite (HTML/CSS/ES-Module), kein Build-Schritt |
| Hosting | GitHub Pages (kostenlos, öffentliche URL) |
| Datenspeicher | `board.json` in einem **privaten** GitHub-Repository, geschrieben über die GitHub Contents API |
| Zugangsschutz | Ein gemeinsamer PIN. Der Repository-Token liegt nur AES-GCM-verschlüsselt vor (PBKDF2-SHA256, 600 000 Runden) |
| Gestaltung | Hausfarben von Winter Media, Sora für Überschriften, Inter für den Fließtext – beide selbst gehostet |
| Kosten | 0 € – GitHub Pages und GitHub-Repositories sind im kostenlosen Tarif enthalten |

Die Daten liegen also serverseitig und versioniert (jede Änderung ist ein Commit),
nicht nur im Browser-Speicher. Der `localStorage` dient ausschließlich als
Zwischenspeicher, damit die Pinnwand sofort sichtbar ist.

### Was eine Aufgabe hat

| Feld | Bedeutung | Vorgabe bei alten Aufgaben |
|---|---|---|
| `priority` | `hoch` / `mittel` / `niedrig` | `mittel` |
| `due` | Frist als `JJJJ-MM-TT`, leer = keine | leer |
| `assignee` | `JAHVIS`, `Kollege` oder leer (= offen) | leer |
| `author` | wer sie angelegt hat | unverändert |
| `comments` | Verlauf aus `{id, author, text, at}` | die alte `note` wird zum ersten Kommentar |
| `url` / `url2` | zwei getrennte Links, je mit eigener Beschriftung | leer |
| `order` | Reihenfolge von Hand innerhalb einer Wichtigkeit | Anlagezeitpunkt |
| `archived` | im Archiv statt gelöscht | `false` |

Zusätzlich führt `board.json` eine Liste `activity` mit den letzten 60 Ereignissen
(„Kollege hat angelegt: …"). Alte Dateien brauchen keine Migration: Fehlende
Felder werden beim Laden mit den Vorgaben oben ergänzt, und zwar auf jedem Gerät
gleich, damit daraus keine überflüssigen Schreibvorgänge entstehen.

### Fristen

Eine Aufgabe mit Frist zeigt ihren Stand als Marke: *heute fällig*, *morgen
fällig*, *3 Tage überfällig*. Überfälliges ist in Gold hervorgehoben. Erledigtes
gilt nie als überfällig. Ganz oben auf der Seite steht die **Morgen-Übersicht**
mit allem, was heute fällig oder überfällig ist – überfällig zuerst. Ein Klick
darauf springt zur Karte.

Die Übersicht ist **immer sichtbar**, auch wenn nichts ansteht: dann sagt sie
das und bietet den Weg zur ersten Frist an. Nur so ist sie auffindbar – eine
Fläche, die sich bei leerem Inhalt versteckt, existiert für die Nutzer nicht.

### Kommentare statt einer Notiz

Der Verlauf wird nur ergänzt, nie überschrieben. Auf der Karte steht der jüngste
Beitrag, der ganze Verlauf öffnet sich über *Kommentare (N)*. Beim
Zusammenführen zweier Stände werden Kommentare **vereinigt** statt ersetzt –
schreiben beide gleichzeitig, bleiben beide Beiträge erhalten.

### Sortieren, Filtern, Suchen

* **Nach Wichtigkeit** (Voreinstellung) – Hoch vor Mittel vor Niedrig, darin die
  Reihenfolge von Hand, sonst die Zeit.
* **Nach Datum** – nach Anlage- bzw. Erledigungszeit.
* **Wichtigkeitsfilter** *Alle / Hoch / Mittel / Niedrig*, der mit den Spalten
  Offen, Dran und Erledigt zusammen greift (z. B. nur Hoch + Offen).
* **Suche** über Titel, Links, Beschriftungen, Namen und alle Kommentare;
  mehrere Wörter müssen alle passen.
* **Erledigt ausblenden** nimmt die dritte Spalte samt Reiter aus der Ansicht.

Diese Einstellungen merkt sich der jeweilige Browser. Sie verändern die
gespeicherten Daten nicht: `board.json` wird immer in derselben Reihenfolge
geschrieben, damit nicht jeder Nutzer die Datei neu schreibt, nur weil er anders
sortiert.

### Reihenfolge von Hand

Innerhalb derselben Wichtigkeit lässt sich die Reihenfolge ändern – am Rechner
durch **Ziehen am Griff** oben rechts auf der Karte, überall sonst über die
Pfeile **↑ ↓** in der Fußzeile der Karte. Beides schreibt nur die gezogene
Aufgabe um (ein Ordnungswert zwischen den Nachbarn), nicht die ganze Spalte.
Möglich ist das nur bei Sortierung *Nach Wichtigkeit* und außerhalb von
*Erledigt* – sonst würde die Sortierung die Handarbeit sofort überschreiben.

### Archiv statt löschen

*Archivieren* nimmt eine Aufgabe aus den Spalten, ohne sie zu verlieren. Über
*Archiv* in der Werkzeugleiste ist sie samt Kommentaren einsehbar und mit einem
Klick wiederherstellbar. Nur im Archiv gibt es zusätzlich *Endgültig löschen*.

### Aktivität und Hinweise

Unter der Pinnwand steht die Aktivitätszeile – standardmäßig aufgeklappt, mit
Überschrift und Zähler; ob sie auf- oder zugeklappt ist, merkt sich der Browser.
Sie ist ebenfalls immer sichtbar.

Für eine Pinnwand, die es schon vor dem Ereignisprotokoll gab, leitet die Seite
den Verlauf zusätzlich aus den vorhandenen Daten ab („angelegt" aus
`createdAt` und `author`, „kommentiert" aus den Kommentaren). Abgeleitetes wird
nur angezeigt, nie gespeichert, und aufgezeichnete Ereignisse zählen nicht
doppelt: verglichen wird je Aufgabe und Art, nicht nach Zeitstempel.

Was seit dem letzten Besuch von der anderen Person kam, zählt der goldene
**N neu**-Knopf in der Kopfzeile; betroffene Karten tragen eine *Neu*-Marke.
Ein Klick hakt alles ab. Der Zähler stützt sich nur auf aufgezeichnete
Ereignisse, nicht auf abgeleitete.

Über die Glocke lassen sich zusätzlich **Browser-Hinweise** einschalten.

> **Grenze, offen gesagt:** Diese Hinweise erscheinen nur, solange die Seite in
> einem Tab geöffnet ist. Echtes Web-Push (Hinweis bei geschlossenem Browser)
> braucht einen eigenen Push-Server mit VAPID-Schlüsseln; GitHub Pages liefert
> nur statische Dateien aus und kann das nicht. Ein bezahlter Maildienst kam
> laut Vorgabe nicht in Frage, deshalb der Zähler in der Kopfzeile als
> verlässlicher Teil und die Browser-Hinweise als Zugabe.

### Links

Eine Aufgabe hat zwei getrennte Linkfelder – etwa Auftrag und Ablageordner.
Ohne eigene Beschriftung bildet die Seite eine lesbare Kurzform aus der Adresse
(`example.com · mein auftrag`); im Bearbeiten-Dialog lässt sich je Link eine
eigene Beschriftung setzen.

> **Grenze:** Die echte Seitenüberschrift eines fremden Links lässt sich von
> einer statischen Seite aus nicht laden – fremde Server erlauben das per CORS
> nicht, und ein Vorschau-Dienst wäre ein zusätzlicher (meist bezahlter)
> Baustein. Deshalb Kurzform aus der Adresse plus eigene Beschriftung.

### Gleichzeitiges Arbeiten

Gespeichert wird immer nach dem Muster *lesen → zusammenführen → schreiben*.
Zusammengeführt wird **pro Aufgabe** anhand des Zeitstempels `updatedAt`,
nicht pro Datei. Ändern beide Personen gleichzeitig verschiedene Aufgaben,
geht nichts verloren; bei einem Schreibkonflikt (HTTP 409) wird bis zu
fünfmal automatisch neu zusammengeführt.

Zwei Dinge sind davon ausgenommen, weil sie Verläufe sind und kein Zustand:
**Kommentare** und die **Aktivität** werden vereinigt statt ersetzt.

---

## Einrichtung (einmalig, ca. 3 Minuten)

Die Seite `setup.html` führt Schritt für Schritt durch:

1. **Privates Repository anlegen**, z. B. `firmen-aufgaben-data`
   (mit README, damit es nicht leer ist).
2. **Fine-grained Personal Access Token** erzeugen:
   * *Repository access* → **Only select repositories** → nur `firmen-aufgaben-data`
   * *Repository permissions → Contents* → **Read and write**
   * Laufzeit möglichst lang wählen
3. Auf `setup.html` Repository, Token und die gewünschte PIN eintragen.
   Die Seite prüft den Zugang, legt `board.json` an, verschlüsselt den Token
   mit der PIN und gibt einen **Zugangslink** aus.
4. Diesen Link an beide Personen schicken, die PIN getrennt davon mitteilen.

Nach dem ersten Öffnen merkt sich der Browser den verschlüsselten Zugang –
ab dann genügt die normale Adresse plus PIN.

---

## Sicherheit – ehrlich betrachtet

* Der Token wird **nie** im Klartext veröffentlicht: im Zugangslink steht nur
  das Chiffrat. Ohne PIN lässt sich damit nichts anfangen.
* Der Token darf ausschließlich auf das eine Datenrepository schreiben.
  Selbst im schlimmsten Fall ist der Schaden auf die Aufgabenliste begrenzt –
  genau auf das, was die PIN ohnehin freigibt.
* Es wirken zwei Faktoren: der Link (mit dem Chiffrat) **und** die PIN.
  Wer nur die PIN kennt, kommt nicht hinein; wer nur den Link hat, ebenfalls nicht.
* Eine reine Ziffern-PIN ist bewusst bequem gewählt. Wer es strenger mag,
  nimmt bei der Einrichtung eine längere PIN mit Buchstaben – die Bedienung
  bleibt identisch.
* Das Datenrepository ist privat, die Aufgaben sind also nicht öffentlich lesbar.

PIN ändern oder Token erneuern: einfach `setup.html` erneut ausführen und den
neuen Link verteilen. Bestehende Aufgaben bleiben dabei erhalten.

---

## Entwicklung

```bash
npm test          # Logik-Tests (Zusammenführen, Datenmodell)
npm run test:e2e  # Oberflächentests in Chromium (benötigt playwright)
npm run dev       # lokaler Server auf http://localhost:4173
```

Die Oberflächentests starten die echte Seite in Chromium und ersetzen nur die
GitHub-API durch einen Speicher im Arbeitsspeicher – Anmeldung, Anlegen,
Verschieben, Notizen, Abgleich und beide Bildschirmgrößen werden dabei geprüft.
Beides läuft bei jedem Push automatisch; danach wird der Stand auf den Zweig
`gh-pages` veröffentlicht und die Live-URL geprüft.

Es gibt keinen Build-Schritt: was im Repository liegt, wird ausgeliefert.

### Gestaltung

Die Oberfläche folgt den Hausfarben von Winter Media: Dunkelgrün `#0A1C1E` für
Navigation und Text, Gold `#B09060` ausschließlich als Akzent (Schaltflächen,
aktive Zustände, Kicker-Punkt), Off-White `#F4F1EC` als Fläche und Petrol
`#12333A` für Karten in der dunklen Ansicht. Farben stehen durchgängig als
HEX-Werte in `:root`; die dunkle Ansicht greift sowohl über
`prefers-color-scheme` als auch über `[data-theme="dark"]`.

Sora (700/800) und Inter (400/500) liegen als woff2 im Repository und werden
von der Seite selbst ausgeliefert – es geht keine Anfrage an einen fremden
Schriftserver. Aktualisiert werden sie über den Workflow
`.github/workflows/fonts.yml`, der `tools/build-fonts.py` benutzt.

### Dateien

```
index.html        Pinnwand inkl. PIN-Anmeldung
setup.html        einmalige Einrichtung
assets/app.js     Oberfläche, Aktionen, Abgleich
assets/board.js   Datenmodell und Merge-Logik (ohne DOM, testbar)
assets/store.js   GitHub Contents API als Datenspeicher
assets/crypto.js  PBKDF2 + AES-GCM
assets/style.css  Gestaltung, hell und dunkel
assets/fonts.css  selbst gehostete Schriften (erzeugt, nicht von Hand ändern)
assets/fonts/     Sora und Inter als woff2
tools/            Aufbereitung des Schrift-CSS
tests/            Tests für board.js
```
