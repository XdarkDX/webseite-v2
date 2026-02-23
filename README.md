# Linktree-ähnliche Web-App (ohne externe Dependencies)

Eine sichere Full-Stack-Web-App nur mit Node.js Built-ins (`http`, `fs`, `path`, `crypto`, `url`) und Vanilla HTML/CSS/JS.

## Empfohlene Node-Version

- **Node.js 18+** (empfohlen Node 20 LTS)

## Start

```bash
ADMIN_USER=admin ADMIN_PASS='SuperSicheresPasswort123!' node server.js
```

Falls `ADMIN_PASS` nicht gesetzt ist, wird beim **ersten Start** ein einmaliges zufälliges Passwort generiert und nur in der Konsole ausgegeben.

## Öffnen

- Öffentliche Seite: http://localhost:3000
- Admin Login: http://localhost:3000/admin/login

## Features

- Öffentliche Profilseite mit Avatar, Name, Bio, optionalem Logo, Footer und Linkliste
- Modernes Dark-Theme (Blau/Dunkelblau), Animationen und Hover-Effekte
- Admin-Bereich mit Login, Session-Cookie, CSRF-Token, CRUD für Links inkl. Reihenfolge
- Profilverwaltung (Name, Bio, Footer, Accent-Farbe) und Bild-Uploads (Avatar/Logo)
- Datenhaltung in `data/db.json`, Uploads in `uploads/`

## Sicherheit

- Passwort-Hashing via `crypto.scrypt` mit per-user Salt
- Initialer Admin aus ENV oder einmaliges generiertes Passwort beim ersten Start
- Signiertes Session-Cookie (HMAC), HttpOnly, SameSite=Strict, Expiry + Rolling Sessions
- CSRF-Schutz über Session-Token in `X-CSRF-Token`
- Security Headers: CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy
- Brute-force Schutz:
  - IP-basiertes In-Memory Rate-Limit mit TTL/Lock
  - User-basiert: `failedAttempts` + `lockedUntil` in `db.json`
- Upload-Sicherheit:
  - Nur PNG/JPG/WEBP
  - Größenlimit
  - Magic-Bytes + MIME-Check
  - Randomisierte Dateinamen

## Projektstruktur

```
/
  server.js
  /public
    index.html
    styles.css
    app.js
    /admin
      login.html
      admin.html
      admin.js
      admin.css
  /data
    db.json
  /uploads
  README.md
```
