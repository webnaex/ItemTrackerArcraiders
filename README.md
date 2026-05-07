# TransferTracker — Arc Raiders

Item-Transfer Tracking zwischen `consta` und `silverbase` vor/nach dem Expedition-Reset.

## Setup

### 1. ARCTracker App registrieren
→ https://arctracker.io/developers
App registrieren → **App-Key** (`arc_k1_...`) kopieren.

### 2. User-Keys erstellen
Für beide Accounts:
→ ARCTracker Settings → Developer Access → **Neuen Key erstellen**
→ Scope: `stash:read` (+ `profile:read` optional)

### 3. Umgebungsvariablen setzen

`.env` Datei (lokal) oder Railway Variables:

```env
ARCTRACKER_APP_KEY=arc_k1_...
ARCTRACKER_USER_KEY_CONSTA=arc_u1_...
ARCTRACKER_USER_KEY_SILVERBASE=arc_u1_...
APP_PASSWORD=deinPasswortHier
DATABASE_URL=postgresql://...
PORT=3000
```

### 4. Auf Railway deployen

```bash
# Railway CLI
railway login
railway init
railway add postgresql    # PostgreSQL Plugin hinzufügen
railway up
```

Oder: GitHub Repo verbinden → Railway Auto-Deploy.

**Railway setzt `DATABASE_URL` und `PORT` automatisch.**

### 5. Lokal testen

```bash
npm install
cp .env.example .env
# .env ausfüllen
npm run dev
# → http://localhost:3000
```

## Verwendung

### Vor dem Reset
1. Tab "Vor Reset" öffnen
2. **"Stash laden"** → silverbase Stash abrufen
3. Items anklicken → Menge anpassen → **"Transfer bestätigen"**

### Nach dem Reset
1. Tab "Nach Reset" öffnen
2. Einzelne Items mit ✓ zurückgeben oder **"Alles zurückgegeben"**

### History
Alle bisherigen Transfers unter "History".

## API Endpoints

| Methode | Pfad | Beschreibung |
|---------|------|--------------|
| GET | `/api/stash/:account` | Stash laden (consta/silverbase) |
| POST | `/api/transfers` | Transfer anlegen |
| GET | `/api/transfers` | Offene Transfers |
| GET | `/api/transfers/history` | Alle Transfers |
| PATCH | `/api/transfers/:id/return` | Item zurückgeben |
| POST | `/api/transfers/return-all` | Alle zurückgeben |
| DELETE | `/api/transfers/:id` | Transfer löschen |

Alle Endpoints erfordern Header: `x-app-password: <APP_PASSWORD>`
