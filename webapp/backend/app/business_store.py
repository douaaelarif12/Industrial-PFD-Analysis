"""Small local SQLite business layer for users, projects and PFDs.

The scientific parsing pipeline remains file/job based; this module only adds
ownership and access control around it.
"""
from __future__ import annotations
import base64, hashlib, hmac, json, os, secrets, sqlite3, time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parents[3]
DB_PATH = PROJECT_ROOT / "webapp" / "runtime" / "pfd_intelligence.sqlite3"
SECRET_PATH = PROJECT_ROOT / "webapp" / "runtime" / ".auth_secret"

class ManagedConnection(sqlite3.Connection):
    def __exit__(self, *args):
        try:
            return super().__exit__(*args)
        finally:
            self.close()

def _conn() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    c = sqlite3.connect(DB_PATH, factory=ManagedConnection)
    c.row_factory = sqlite3.Row
    return c

def _now() -> str: return datetime.now(UTC).isoformat(timespec="seconds")

def _hash_password(password: str, salt: bytes | None = None) -> str:
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 210_000)
    return f"pbkdf2_sha256$210000${base64.urlsafe_b64encode(salt).decode()}${base64.urlsafe_b64encode(digest).decode()}"

def verify_password(password: str, encoded: str) -> bool:
    try:
        _, rounds, salt, expected = encoded.split("$", 3)
        actual = hashlib.pbkdf2_hmac("sha256", password.encode(), base64.urlsafe_b64decode(salt), int(rounds))
        return hmac.compare_digest(base64.urlsafe_b64encode(actual).decode(), expected)
    except (ValueError, TypeError): return False

def init_db() -> None:
    with _conn() as c:
        c.executescript("""
        CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','user')), active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, FOREIGN KEY(created_by) REFERENCES users(id));
        CREATE TABLE IF NOT EXISTS project_users (project_id TEXT NOT NULL, user_id TEXT NOT NULL, PRIMARY KEY(project_id,user_id), FOREIGN KEY(project_id) REFERENCES projects(id), FOREIGN KEY(user_id) REFERENCES users(id));
        CREATE TABLE IF NOT EXISTS pfds (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, filename TEXT NOT NULL, original_path TEXT NOT NULL, sha256 TEXT NOT NULL, uploaded_by TEXT NOT NULL, uploaded_at TEXT NOT NULL, FOREIGN KEY(project_id) REFERENCES projects(id));
        CREATE TABLE IF NOT EXISTS analysis_links (analysis_id TEXT PRIMARY KEY, pfd_id TEXT NOT NULL, created_at TEXT NOT NULL, FOREIGN KEY(pfd_id) REFERENCES pfds(id));
        """)
        if not c.execute("SELECT 1 FROM users LIMIT 1").fetchone():
            admin = add_user(c, "Administrateur JESA", "admin@jesa.local", "Admin123!", "admin")
            user = add_user(c, "Utilisateur JESA", "user@jesa.local", "User123!", "user")
            pid = "project-demo"
            now = _now(); c.execute("INSERT INTO projects VALUES (?,?,?,?,?,?)", (pid, "Projet de démonstration", "Espace local de démonstration", admin, now, now))
            c.execute("INSERT INTO project_users VALUES (?,?)", (pid, admin)); c.execute("INSERT INTO project_users VALUES (?,?)", (pid, user))
        admin_row = c.execute("SELECT id FROM users WHERE email=?", ("admin@jesa.local",)).fetchone()
        if admin_row:
            catalog = [
                ("Projet Phosphate", "Unité de traitement et de valorisation du phosphate.", 5),
                ("Projet Flottation", "Circuit de flottation et filtration.", 4),
                ("Projet Attrition", "Système d’attrition et de déschlammage.", 3),
                ("Projet Filtration", "Filtration et traitement du produit final.", 6),
                ("Projet Utilities", "Réseaux d’utilités : eau, vapeur, air, etc.", 4),
                ("Projet Stockage", "Stockage et expédition.", 2),
            ]
            for name, description, _count in catalog:
                existing = c.execute("SELECT id FROM projects WHERE name=?", (name,)).fetchone()
                if not existing:
                    pid = "project-" + secrets.token_hex(8); now = _now()
                    c.execute("INSERT INTO projects VALUES (?,?,?,?,?,?)", (pid,name,description,admin_row[0],now,now))
                    c.execute("INSERT OR IGNORE INTO project_users VALUES (?,?)", (pid,admin_row[0]))

def add_user(c: sqlite3.Connection, name: str, email: str, password: str, role: str) -> str:
    uid = "user-" + secrets.token_hex(8); c.execute("INSERT INTO users VALUES (?,?,?,?,?,?,?)", (uid,name,email.lower(),_hash_password(password),role,1,_now())); return uid

def user_by_email(email: str) -> dict[str, Any] | None:
    with _conn() as c:
        row = c.execute("SELECT * FROM users WHERE email=?", (email.lower().strip(),)).fetchone()
        return dict(row) if row else None
def user_by_id(uid: str) -> dict[str, Any] | None:
    with _conn() as c:
        row = c.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone(); return dict(row) if row else None
def list_users() -> list[dict[str,Any]]:
        with _conn() as c: return [dict(r) for r in c.execute("SELECT id,name,email,role,active,created_at FROM users ORDER BY created_at")]
def update_user(uid: str, payload: dict[str,Any]) -> dict[str,Any] | None:
    fields=[]; values=[]
    for key in ("name","email","role","active"):
        if key in payload: fields.append(f"{key}=?"); values.append(payload[key] if key != "email" else str(payload[key]).lower().strip())
    if "password" in payload: fields.append("password_hash=?"); values.append(_hash_password(str(payload["password"])))
    if not fields: return user_by_id(uid)
    values.append(uid)
    with _conn() as c:c.execute("UPDATE users SET "+",".join(fields)+" WHERE id=?",values)
    return user_by_id(uid)

def _secret() -> bytes:
    SECRET_PATH.parent.mkdir(parents=True, exist_ok=True)
    if not SECRET_PATH.exists(): SECRET_PATH.write_bytes(secrets.token_bytes(32))
    return SECRET_PATH.read_bytes()
def issue_token(user: dict[str,Any]) -> str:
    payload = base64.urlsafe_b64encode(json.dumps({"sub":user["id"],"exp":int(time.time())+28800}, separators=(",",":")).encode()).decode().rstrip("=")
    sig = hmac.new(_secret(), payload.encode(), hashlib.sha256).digest(); return payload+"."+base64.urlsafe_b64encode(sig).decode().rstrip("=")
def user_from_token(token: str) -> dict[str,Any] | None:
    try:
        payload, sig = token.split(".",1); expected = hmac.new(_secret(), payload.encode(), hashlib.sha256).digest()
        if not hmac.compare_digest(base64.urlsafe_b64decode(sig+"="*((4-len(sig)%4)%4)), expected): return None
        data=json.loads(base64.urlsafe_b64decode(payload+"="*((4-len(payload)%4)%4))); user=user_by_id(str(data["sub"]))
        return user if user and user["active"] and int(data["exp"]) > time.time() else None
    except (ValueError, KeyError, TypeError, json.JSONDecodeError): return None

def create_project(name: str, description: str, creator: str, members: list[str] | None = None) -> dict[str,Any]:
    pid="project-"+secrets.token_hex(8); now=_now()
    with _conn() as c:
        c.execute("INSERT INTO projects VALUES (?,?,?,?,?,?)", (pid,name,description,creator,now,now)); c.execute("INSERT INTO project_users VALUES (?,?)",(pid,creator))
        for uid in members or []: c.execute("INSERT OR IGNORE INTO project_users VALUES (?,?)",(pid,uid))
    return project(pid)
def project(pid: str) -> dict[str,Any] | None:
    with _conn() as c:
        row=c.execute("SELECT * FROM projects WHERE id=?",(pid,)).fetchone()
        if not row:return None
        out=dict(row); out["members"]=[dict(r) for r in c.execute("SELECT u.id,u.name,u.email,u.role FROM users u JOIN project_users pu ON pu.user_id=u.id WHERE pu.project_id=?",(pid,))]; out["pfd_count"]=c.execute("SELECT COUNT(*) FROM pfds WHERE project_id=?",(pid,)).fetchone()[0]; return out
def list_projects(user: dict[str,Any]) -> list[dict[str,Any]]:
    with _conn() as c:
        q="SELECT p.id FROM projects p" if user["role"]=="admin" else "SELECT p.id FROM projects p JOIN project_users pu ON pu.project_id=p.id WHERE pu.user_id=?"
        rows=c.execute(q,() if user["role"]=="admin" else (user["id"],)).fetchall(); return [project(r[0]) for r in rows]
def can_access_project(pid: str, user: dict[str,Any]) -> bool:
    if user["role"]=="admin": return project(pid) is not None
    with _conn() as c:return c.execute("SELECT 1 FROM project_users WHERE project_id=? AND user_id=?",(pid,user["id"])).fetchone() is not None
def assign_user(pid: str, uid: str) -> None:
    with _conn() as c:c.execute("INSERT OR IGNORE INTO project_users VALUES (?,?)",(pid,uid))
def remove_user(pid: str, uid: str) -> None:
    with _conn() as c:c.execute("DELETE FROM project_users WHERE project_id=? AND user_id=?",(pid,uid))
def add_pfd(pid: str, filename: str, path: str, sha: str, uid: str) -> dict[str,Any]:
    fid="pfd-"+secrets.token_hex(8)
    with _conn() as c:c.execute("INSERT INTO pfds VALUES (?,?,?,?,?,?,?)",(fid,pid,filename,path,sha,uid,_now()))
    return pfd(fid)
def pfds(pid: str) -> list[dict[str,Any]]:
    with _conn() as c:return [dict(r) for r in c.execute("SELECT * FROM pfds WHERE project_id=? ORDER BY uploaded_at DESC",(pid,))]
def pfd(fid: str) -> dict[str,Any] | None:
    with _conn() as c:
        r=c.execute("SELECT * FROM pfds WHERE id=?",(fid,)).fetchone(); return dict(r) if r else None
def link_analysis(aid: str, fid: str) -> None:
    with _conn() as c:
        if not c.execute("SELECT 1 FROM pfds p JOIN projects r ON r.id=p.project_id WHERE p.id=?", (fid,)).fetchone():
            raise ValueError("PFD et projet requis")
        existing = c.execute("SELECT pfd_id FROM analysis_links WHERE analysis_id=?", (aid,)).fetchone()
        if existing and existing[0] != fid:
            raise ValueError("Une analyse ne peut pas changer de PFD")
        c.execute("INSERT OR IGNORE INTO analysis_links VALUES (?,?,?)",(aid,fid,_now()))
def analysis_for_pfd(fid: str) -> str | None:
    with _conn() as c:
        row=c.execute("SELECT analysis_id FROM analysis_links WHERE pfd_id=? ORDER BY created_at DESC LIMIT 1",(fid,)).fetchone(); return str(row[0]) if row else None
def analysis_ids_for_project(pid: str) -> list[str]:
    """Return every persisted analysis linked to a PFD in this project."""
    with _conn() as c:
        rows = c.execute(
            """SELECT a.analysis_id
               FROM analysis_links a
               JOIN pfds p ON p.id = a.pfd_id
               WHERE p.project_id = ?
               ORDER BY a.created_at DESC""",
            (pid,),
        ).fetchall()
        return [str(row[0]) for row in rows]
def pfd_for_analysis(aid: str) -> dict[str,Any] | None:
    with _conn() as c:
        row=c.execute("SELECT p.* FROM pfds p JOIN analysis_links a ON a.pfd_id=p.id WHERE a.analysis_id=?",(aid,)).fetchone(); return dict(row) if row else None
def delete_project(pid: str) -> None:
    with _conn() as c:
        if c.execute("SELECT 1 FROM pfds WHERE project_id=?", (pid,)).fetchone():
            raise ValueError("Ce projet contient des PFD ; sa suppression créerait des analyses orphelines.")
        c.execute("DELETE FROM project_users WHERE project_id=?",(pid,)); c.execute("DELETE FROM pfds WHERE project_id=?",(pid,)); c.execute("DELETE FROM projects WHERE id=?",(pid,))
def update_project(pid: str, name: str, description: str) -> dict[str,Any] | None:
    with _conn() as c:c.execute("UPDATE projects SET name=?,description=?,updated_at=? WHERE id=?",(name,description,_now(),pid))
    return project(pid)
