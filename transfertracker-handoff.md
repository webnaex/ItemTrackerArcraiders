# TransferTracker — Handoff für Claude Cowork

## Was bereits fertig ist
Der komplette Code ist gebaut und als ZIP herunterladbar (`transfer-tracker.zip`).

### Projektstruktur
```
transfer-tracker/
├── src/
│   ├── server.js       — Express Server + alle API Routen
│   ├── db.js           — PostgreSQL (auto-init beim Start)
│   └── arctracker.js   — ARCTracker API Client
├── public/
│   └── index.html      — komplettes Frontend (single file)
├── .env.example        — alle benötigten Env Vars
├── railway.json        — Railway Deploy Config
└── README.md
```

## Was noch zu tun ist (in dieser Reihenfolge)

### Schritt 1 — silverbase User-Key holen
- URL: https://arctracker.io/settings
- Abschnitt: "Developer Access"
- Neuen Key erstellen, Scope: `stash:read`
- Key kopieren (`arc_u1_...`)
- **User ist bereits eingeloggt als silverbase**

### Schritt 2 — App-Key registrieren
- URL: https://arctracker.io/developers
- "Register App" → Name: `TransferTracker`
- App-Key kopieren (`arc_k1_...`)

### Schritt 3 — consta User-Key holen
- Bei ARCTracker als `consta` einloggen
- Settings → Developer Access → Key erstellen, Scope: `stash:read`
- Key kopieren

### Schritt 4 — Railway Setup
- https://railway.app → New Project → Empty Project
- PostgreSQL Plugin hinzufügen
- GitHub Repo erstellen, Code pushen, mit Railway verbinden
- Env Vars setzen:
  ```
  ARCTRACKER_APP_KEY                 = arc_k1_...
  ARCTRACKER_USER_KEY_CONSTA         = arc_u1_...
  ARCTRACKER_USER_KEY_SILVERBASE     = arc_u1_...
  APP_PASSWORD                       = (Wunschpasswort)
  DATABASE_URL                       = (Railway setzt automatisch)
  ```

## Accounts
- `silverbase` — Lager-Account (Stash wird hier abgerufen)
- `consta` — Haupt-Account

## API die verwendet wird
- ARCTracker.io API: `GET /api/v2/user/stash?locale=de&per_page=500`
- Dual-Key Auth: `X-App-Key` + `Authorization: Bearer`

## Tech Stack
- Node.js + Express, PostgreSQL, Single HTML Frontend
- Hosting: Railway (neue separate App)
