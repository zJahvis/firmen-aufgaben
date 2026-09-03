# Firmen-Aufgaben

Gemeinsame Aufgaben-Pinnwand für zwei Personen mit den drei Spalten
**Offen · Dran · Erledigt** – komplett auf Deutsch, mobiltauglich, PIN-geschützt
und ohne einen einzigen kostenpflichtigen Dienst.

* **Der Kollege** legt Aufgaben an (Titel + optionaler Link).
* **JAHVIS** arbeitet sie ab, schreibt Notizen dazu und hakt sie ab.
* Beide sehen dieselbe Pinnwand, auf jedem Gerät, in Echtzeit (Abgleich alle 10 Sekunden).

---

## Wie es aufgebaut ist

| Teil | Umsetzung |
|---|---|
| Oberfläche | Statische Seite (HTML/CSS/ES-Module), kein Build-Schritt |
| Hosting | GitHub Pages (kostenlos, öffentliche URL) |
| Datenspeicher | `board.json` in einem **privaten** GitHub-Repository, geschrieben über die GitHub Contents API |
| Zugangsschutz | Ein gemeinsamer PIN. Der Repository-Token liegt nur AES-GCM-verschlüsselt vor (PBKDF2-SHA256, 600 000 Runden) |
| Kosten | 0 € – GitHub Pages und GitHub-Repositories sind im kostenlosen Tarif enthalten |

Die Daten liegen also serverseitig und versioniert (jede Änderung ist ein Commit),
nicht nur im Browser-Speicher. Der `localStorage` dient ausschließlich als
Zwischenspeicher, damit die Pinnwand sofort sichtbar ist.

### Gleichzeitiges Arbeiten

Gespeichert wird immer nach dem Muster *lesen → zusammenführen → schreiben*.
Zusammengeführt wird **pro Aufgabe** anhand des Zeitstempels `updatedAt`,
nicht pro Datei. Ändern beide Personen gleichzeitig verschiedene Aufgaben,
geht nichts verloren; bei einem Schreibkonflikt (HTTP 409) wird bis zu
fünfmal automatisch neu zusammengeführt.

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

### Dateien

```
index.html        Pinnwand inkl. PIN-Anmeldung
setup.html        einmalige Einrichtung
assets/app.js     Oberfläche, Aktionen, Abgleich
assets/board.js   Datenmodell und Merge-Logik (ohne DOM, testbar)
assets/store.js   GitHub Contents API als Datenspeicher
assets/crypto.js  PBKDF2 + AES-GCM
assets/style.css  Gestaltung, hell und dunkel
tests/            Tests für board.js
```
