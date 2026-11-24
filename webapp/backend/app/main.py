from __future__ import annotations

import json
import os
import sqlite3
import re
import shutil
import tempfile
import threading
from uuid import uuid4
from collections import Counter
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, File, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse, HTMLResponse

from .analysis_jobs import JOBS_ROOT, PROJECT_ROOT, active_running_job, file_sha256, get_job, job_dir, latest_completed_job, update_job, create_job
from .data_service import FINAL_JSON, equipment_by_tag, graph_payload, load_demo, summary_payload
from .pipeline_service import start_analysis_job
from .business_store import add_pfd, analysis_for_pfd, analysis_ids_for_project, assign_user, can_access_project, create_project, delete_project, init_db, issue_token, link_analysis, list_projects, list_users, pfd, pfd_for_analysis, pfds, project, remove_user, update_project, update_user, user_by_email, user_by_id, user_from_token, verify_password


def _load_local_env() -> None:
    """Read local development settings without adding a dotenv dependency."""

    env_path = Path(__file__).resolve().parents[1] / ".env"
    if not env_path.is_file():
        return
    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


_load_local_env()
REQUIRE_AUTH = os.getenv("REQUIRE_AUTH", "true").lower() not in {"0", "false", "no"}


def require_authenticated_user(authorization: str | None = Header(default=None)) -> dict:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Authentication required")
    token = authorization.removeprefix("Bearer ").strip()
    user = user_from_token(token)
    if not user: raise HTTPException(status_code=401, detail="Invalid or expired session")
    return user


@asynccontextmanager
async def lifespan(_: FastAPI):
    # Fail early if the frozen presentation data is unavailable.
    load_demo()
    init_db()
    yield


app = FastAPI(title="PFD Intelligence API", version="0.1.0", lifespan=lifespan)
@app.middleware("http")
async def project_context_required(request, call_next):
    if request.url.path.startswith("/api/demo/"):
        return JSONResponse({"detail": "Consultez les résultats depuis le PFD de son projet."}, status_code=410)
    return await call_next(request)
origins = [origin.strip() for origin in os.getenv("ALLOWED_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173").split(",") if origin.strip()]
app.add_middleware(CORSMiddleware, allow_origins=origins, allow_credentials=False, allow_methods=["*"], allow_headers=["*"])
# Generated analysis files remain isolated by analysis id.  This read-only local
# mount lets the web interface display the real rendered/annotated artifacts.
JOBS_ROOT.mkdir(parents=True, exist_ok=True)

# This is a read-only publication of the already validated Stage 08 PFD-230
# graph.  It is never used as a fallback for another upload: the result route
# below exposes it only after a SHA-256 identity check of the uploaded PDF.
REFERENCE_PFD230 = PROJECT_ROOT / "data" / "input" / "PLAN_A7BF7C1F_ANONYME.pdf"
REFERENCE_GRAPH_DIR = PROJECT_ROOT / "results" / "neo4j_pfd230_20260901"
ANALYSIS_LOCK = threading.Lock()
RUNNING_ANALYSIS_STATUSES = {"queued", "rendering_pdf", "running_ocr", "running_yolo", "associating"}


@app.get("/api/health")
def health() -> dict[str, str | bool]:
    return {"status": "ok", "data_source": str(FINAL_JSON), "demo_mode": True, "generic_upload_queue": True}

@app.post("/api/auth/login")
def login(payload: dict) -> dict:
    user = user_by_email(str(payload.get("email", "")))
    if not user or not user["active"] or not verify_password(str(payload.get("password", "")), user["password_hash"]):
        raise HTTPException(status_code=401, detail="E-mail ou mot de passe incorrect")
    return {"access_token": issue_token(user), "token_type": "bearer", "user": {k:user[k] for k in ("id","name","email","role","active","created_at")}}

@app.get("/api/auth/me")
def auth_me(user: dict = Depends(require_authenticated_user)) -> dict:
    return {k:user[k] for k in ("id","name","email","role","active","created_at") if k in user}

@app.post("/api/auth/logout")
def logout(_: dict = Depends(require_authenticated_user)) -> dict[str,str]: return {"status":"ok"}

def admin_only(user: dict) -> None:
    if user.get("role") != "admin": raise HTTPException(status_code=403, detail="Droits administrateur requis")

def authorized_analysis(analysis_id: str, user: dict) -> dict:
    if not re.fullmatch(r"analysis-[a-zA-Z0-9-]+", analysis_id):
        raise HTTPException(status_code=404, detail="Analyse introuvable")
    linked = pfd_for_analysis(analysis_id)
    if not linked or not can_access_project(linked["project_id"], user): raise HTTPException(status_code=404, detail="Analyse introuvable")
    return linked

def contextual_job(aid: str, user: dict) -> dict:
    item = authorized_analysis(aid, user)
    job = get_job(aid)
    if not job: raise HTTPException(status_code=404, detail="Analyse introuvable")
    return {**job, "pfd_id": item["id"], "project_id": item["project_id"], "project_name": project(item["project_id"])["name"]}

def document_payload(item: dict) -> dict:
    aid = analysis_for_pfd(item["id"])
    job = get_job(aid) if aid else None
    uploader = user_by_id(item["uploaded_by"])
    return {**item, "stored_path": item["original_path"], "uploaded_by_name": uploader["name"] if uploader else item["uploaded_by"],
            "analysis_id": aid, "status": job.get("status", "not_analyzed") if job else "not_analyzed",
            "last_analysis_at": (job.get("updated_at") or job.get("created_at")) if job else None}

def project_payload(item: dict) -> dict:
    """Enrich a stored project with factual, computed workspace indicators."""
    jobs = [get_job(aid) for aid in analysis_ids_for_project(item["id"])]
    jobs = [job for job in jobs if job]
    creator = user_by_id(item["created_by"])
    return {
        **item,
        # The current persistence model has no archive/inactive state: a stored
        # project is active until it is explicitly deleted.
        "status": "active",
        "created_by_name": creator["name"] if creator else item["created_by"],
        "member_count": len(item.get("members", [])),
        "analysis_counts": {
            "completed": sum(job.get("status") == "completed" for job in jobs),
            "running": sum(job.get("status") in RUNNING_ANALYSIS_STATUSES for job in jobs),
            "failed": sum(job.get("status") == "failed" for job in jobs),
        },
    }

@app.get("/api/workspace")
def workspace(user: dict = Depends(require_authenticated_user)):
    accessible = list_projects(user)
    documents = [document_payload(d) for p in accessible for d in pfds(p["id"])]
    recent = [contextual_job(d["analysis_id"], user) for d in documents if d["analysis_id"] and get_job(d["analysis_id"])]
    recent.sort(key=lambda j: j.get("updated_at", ""), reverse=True)
    return {"projects": len(accessible), "pfds": len(documents), "users": len(list_users()) if user["role"] == "admin" else None,
            "completed": sum(d["status"] == "completed" for d in documents),
            "running": sum(d["status"] in {"queued","rendering_pdf","running_ocr","running_yolo","associating"} for d in documents), "recent": recent[:8]}

@app.get("/analysis-files/{analysis_id}/{filename:path}")
def artifact(analysis_id: str, filename: str, user: dict = Depends(require_authenticated_user)):
    authorized_analysis(analysis_id, user)
    root = job_dir(analysis_id).resolve()
    target = (root / filename).resolve()
    if not target.is_relative_to(root) or not target.is_file(): raise HTTPException(status_code=404, detail="Fichier introuvable")
    return FileResponse(target)

@app.get("/api/analyses/{analysis_id}/reference/{filename}")
def reference_artifact(analysis_id: str, filename: str, user: dict = Depends(require_authenticated_user)):
    job = contextual_job(analysis_id, user)
    if filename not in {"pfd230_graph_preview.html", "pfd230_graph_preview.png"} or not _validated_reference_graph(job)["available"]:
        raise HTTPException(status_code=404, detail="Graphe non validé pour ce document")
    if filename.endswith('.html'):
        return HTMLResponse(reference_graph_document(), media_type="text/html; charset=utf-8")
    return FileResponse(REFERENCE_GRAPH_DIR / filename)

def reference_graph_document() -> str:
    # Stage 08 exports a UTF-8 HTML fragment. Give standalone/blob viewing an
    # explicit encoding without rewriting its scientific SVG or source file.
    fragment = (REFERENCE_GRAPH_DIR / "pfd230_graph_preview.html").read_text(encoding="utf-8")
    return ('<!doctype html><html lang="fr"><head><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width, initial-scale=1">'
            '<title>Graphe des équipements — PFD-230</title>'
            '<style>body{margin:0;padding:12px;background:white;box-sizing:border-box}'
            '#pfd230-graph-preview>h1,#pfd230-graph-preview>p{display:none}</style>'
            '</head><body>' + fragment + '</body></html>')

@app.get("/api/users")
def users(user: dict = Depends(require_authenticated_user)):
    admin_only(user); return {"items": list_users()}

@app.post("/api/users")
def create_user(payload: dict, user: dict = Depends(require_authenticated_user)):
    admin_only(user)
    if payload.get("role", "user") not in {"admin", "user"} or len(str(payload.get("password", ""))) < 8 or "@" not in str(payload.get("email", "")):
        raise HTTPException(status_code=400, detail="Rôle, e-mail ou mot de passe invalide (8 caractères minimum)")
    from .business_store import _conn, add_user
    try:
        with _conn() as c: uid=add_user(c,str(payload.get("name","Utilisateur")),str(payload["email"]),str(payload["password"]),str(payload.get("role","user")))
    except (KeyError, sqlite3.IntegrityError) as exc: raise HTTPException(status_code=400, detail="Utilisateur invalide ou e-mail déjà utilisé") from exc
    return {k:v for k,v in user_by_id(uid).items() if k != "password_hash"}

@app.put("/api/users/{user_id}")
def user_update(user_id: str, payload: dict, user: dict = Depends(require_authenticated_user)):
    admin_only(user)
    if not user_by_id(user_id): raise HTTPException(status_code=404, detail="Utilisateur introuvable")
    if "role" in payload and payload["role"] not in {"admin", "user"}: raise HTTPException(status_code=400, detail="Rôle invalide")
    if "password" in payload and len(str(payload["password"])) < 8: raise HTTPException(status_code=400, detail="Mot de passe trop court")
    if user_id == user["id"] and (payload.get("role", "admin") != "admin" or payload.get("active", 1) not in {1, True}):
        raise HTTPException(status_code=409, detail="Vous ne pouvez pas retirer votre propre accès administrateur.")
    try: updated = update_user(user_id, payload)
    except sqlite3.IntegrityError as exc: raise HTTPException(status_code=400, detail="Données utilisateur invalides ou e-mail déjà utilisé") from exc
    return {k:v for k,v in updated.items() if k != "password_hash"}

@app.delete("/api/users/{user_id}")
def user_deactivate(user_id: str, user: dict = Depends(require_authenticated_user)):
    admin_only(user)
    if not user_by_id(user_id): raise HTTPException(status_code=404, detail="Utilisateur introuvable")
    return {k:v for k,v in update_user(user_id, {"active": 0}).items() if k != "password_hash"}

@app.get("/api/projects")
def projects(user: dict = Depends(require_authenticated_user)): return {"items": [project_payload(item) for item in list_projects(user)]}

@app.post("/api/projects")
def project_create(payload: dict, user: dict = Depends(require_authenticated_user)):
    admin_only(user)
    name = str(payload.get("name", "")).strip()
    members = list(payload.get("user_ids", []))
    if not name or any(not user_by_id(uid) for uid in members): raise HTTPException(status_code=400, detail="Nom ou membres invalides")
    return create_project(name, str(payload.get("description", "")), user["id"], members)

@app.get("/api/projects/{project_id}")
def project_detail(project_id: str, user: dict = Depends(require_authenticated_user)):
    if not can_access_project(project_id,user): raise HTTPException(status_code=404, detail="Projet introuvable")
    return project_payload(project(project_id))

@app.put("/api/projects/{project_id}")
def project_update(project_id: str, payload: dict, user: dict = Depends(require_authenticated_user)):
    admin_only(user)
    if not project(project_id): raise HTTPException(status_code=404, detail="Projet introuvable")
    return update_project(project_id,str(payload.get("name","Projet")),str(payload.get("description","")))

@app.delete("/api/projects/{project_id}")
def project_remove(project_id: str, user: dict = Depends(require_authenticated_user)):
    admin_only(user)
    try: delete_project(project_id)
    except ValueError as exc: raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"status":"deleted"}

@app.post("/api/projects/{project_id}/users/{user_id}")
def project_assign(project_id: str, user_id: str, user: dict = Depends(require_authenticated_user)):
    admin_only(user)
    if not project(project_id) or not user_by_id(user_id): raise HTTPException(status_code=404, detail="Projet ou utilisateur introuvable")
    assign_user(project_id,user_id); return project(project_id)

@app.post("/api/projects/{project_id}/users")
def project_assign_many(project_id: str, payload: dict, user: dict = Depends(require_authenticated_user)):
    admin_only(user)
    if not project(project_id): raise HTTPException(status_code=404, detail="Projet introuvable")
    for uid in payload.get("user_ids", []):
        if user_by_id(str(uid)): assign_user(project_id, str(uid))
    return project(project_id)

@app.delete("/api/projects/{project_id}/users/{user_id}")
def project_unassign(project_id: str, user_id: str, user: dict = Depends(require_authenticated_user)):
    admin_only(user); remove_user(project_id,user_id); return project(project_id)

@app.post("/api/projects/{project_id}/pfds")
async def project_pfd_upload(project_id: str, file: UploadFile = File(...), user: dict = Depends(require_authenticated_user)):
    if not can_access_project(project_id,user): raise HTTPException(status_code=404, detail="Projet introuvable")
    if not file.filename or not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Un fichier PDF est requis")
    directory = PROJECT_ROOT / "webapp" / "runtime" / "documents" / uuid4().hex
    directory.mkdir(parents=True)
    target = directory / "source.pdf"
    with target.open("wb") as handle:
        while chunk := await file.read(1024 * 1024): handle.write(chunk)
    with target.open("rb") as handle:
        if b"%PDF-" not in handle.read(1024):
            target.unlink(); directory.rmdir()
            raise HTTPException(status_code=400, detail="Contenu PDF invalide")
    item = add_pfd(project_id, Path(file.filename).name, str(target), file_sha256(target), user["id"])
    return {"pfd": document_payload(item), "status": "not_analyzed"}

@app.get("/api/projects/{project_id}/pfds")
def project_pfds(project_id: str, user: dict = Depends(require_authenticated_user)):
    if not can_access_project(project_id,user): raise HTTPException(status_code=404, detail="Projet introuvable")
    return {"items":[document_payload(item) for item in pfds(project_id)]}

@app.get("/api/pfds/{pfd_id}")
def pfd_detail(pfd_id: str, user: dict = Depends(require_authenticated_user)):
    item=pfd(pfd_id)
    if not item or not can_access_project(item["project_id"],user): raise HTTPException(status_code=404, detail="PFD introuvable")
    return document_payload(item)

@app.post("/api/pfds/{pfd_id}/analyze")
def pfd_analyze(pfd_id: str, user: dict = Depends(require_authenticated_user)):
    item=pfd(pfd_id)
    if not item or not can_access_project(item["project_id"],user): raise HTTPException(status_code=404, detail="PFD introuvable")
    with ANALYSIS_LOCK:
        aid = analysis_for_pfd(pfd_id)
        job = get_job(aid) if aid else None
        if job and job.get("status") in {"failed", "cancelled"}:
            # Keep the failed attempt and its log; a retry gets its own id.
            job = None
        if job and (job.get("worker_started") or job.get("status") == "completed"):
            return contextual_job(aid, user)
        if active_running_job(): raise HTTPException(status_code=409, detail="Une analyse est déjà en cours. Réessayez après sa fin.")
        if not job:
            with tempfile.TemporaryDirectory() as folder:
                source = Path(folder) / "source.pdf"
                shutil.copyfile(PROJECT_ROOT / item["original_path"], source)
                job = create_job(source, item["filename"])
            aid = job["analysis_id"]
            link_analysis(aid, pfd_id)
        update_job(aid, project_id=item["project_id"], pfd_id=pfd_id, user_id=user["id"])
        start_analysis_job(aid)
        return contextual_job(aid, user)


@app.get("/api/demo/document")
def document(_: dict = Depends(require_authenticated_user)):
    return load_demo()["document"]


@app.get("/api/demo/summary")
def summary(_: dict = Depends(require_authenticated_user)):
    return summary_payload()


@app.get("/api/demo/equipment")
def equipment(_: dict = Depends(require_authenticated_user)):
    return {"items": load_demo()["equipment"], "count": len(load_demo()["equipment"])}


@app.get("/api/demo/equipment/{tag}")
def equipment_detail(tag: str, _: dict = Depends(require_authenticated_user)):
    item = equipment_by_tag(tag)
    if item is None:
        raise HTTPException(status_code=404, detail="Equipment tag not found")
    return item


@app.get("/api/demo/connections")
def connections(_: dict = Depends(require_authenticated_user)):
    data = load_demo()["process_connections"]
    return {"items": data, "count": len(data), "all_directions_unknown": all(item["direction"] == "unknown" for item in data)}


@app.get("/api/demo/arrows")
def arrows(_: dict = Depends(require_authenticated_user)):
    data = load_demo()["flow_arrows"]
    return {"items": data, "count": len(data)}


@app.get("/api/demo/graph")
def graph(_: dict = Depends(require_authenticated_user)):
    return graph_payload()


@app.get("/api/demo/json")
def demo_json(_: dict = Depends(require_authenticated_user)):
    return load_demo()


@app.post("/api/analyze")
async def analyze(file: UploadFile = File(...), _: dict = Depends(require_authenticated_user)):
    raise HTTPException(status_code=410, detail="Ouvrez un projet, téléversez un PFD puis utilisez /api/pfds/{pfd_id}/analyze")


@app.get("/api/analyses/active")
def active_analysis_status(user: dict = Depends(require_authenticated_user)):
    """Let a refreshed browser reattach to the one local analysis in progress."""

    return {"job": next((j for j in workspace(user)["recent"] if j["status"] in {"queued","rendering_pdf","running_ocr","running_yolo","associating"}), None)}


@app.get("/api/analyses/latest")
def latest_analysis_status(user: dict = Depends(require_authenticated_user)):
    """Restore the most recent usable result after a browser refresh."""

    return {"job": next((j for j in workspace(user)["recent"] if j["status"] == "completed"), None)}


@app.post("/api/analyses/{analysis_id}/cancel")
def cancel_analysis(analysis_id: str, user: dict = Depends(require_authenticated_user)):
    """Request cancellation of a user-owned local analysis.

    The dedicated worker observes this state within half a second and stops its
    OCR/YOLO child process tree.  Existing completed artifacts are untouched.
    """

    authorized_analysis(analysis_id, user)
    job = get_job(analysis_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Analysis job not found")
    if job.get("status") in {"completed", "failed", "cancelled"}:
        return {"analysis_id": analysis_id, "status": job.get("status")}
    updated = update_job(
        analysis_id,
        status="cancelled",
        message="Analyse annulée : la page ou l’application a été fermée.",
    )
    worker_pid = job.get("worker_pid")
    if isinstance(worker_pid, int) and worker_pid > 0 and os.name == "nt":
        # The PID belongs to the dedicated worker created for this exact job.
        # /T includes the OCR/YOLO subprocesses it started.
        import subprocess

        subprocess.run(
            ["taskkill", "/PID", str(worker_pid), "/T", "/F"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
    return {"analysis_id": analysis_id, "status": updated["status"]}


def _load_json(path: Path, label: str) -> dict:
    if not path.is_file():
        raise HTTPException(status_code=404, detail=f"{label} artifact is unavailable")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=500, detail=f"{label} artifact is invalid JSON") from exc


def _public_artifact_url(analysis_id: str, path: str | None) -> str | None:
    if not path:
        return None
    candidate = Path(path)
    root = job_dir(analysis_id).resolve()
    try:
        relative = candidate.resolve().relative_to(root)
    except ValueError:
        return None
    return f"/analysis-files/{analysis_id}/{relative.as_posix()}"


def _validated_reference_graph(job: dict) -> dict:
    """Expose the frozen PFD-230 graph only for byte-identical uploads."""

    source = PROJECT_ROOT / str(job.get("source_file", ""))
    reference_ready = (
        REFERENCE_PFD230.is_file()
        and (REFERENCE_GRAPH_DIR / "pfd230_graph_preview.html").is_file()
        and (REFERENCE_GRAPH_DIR / "pfd230_graph_preview.png").is_file()
    )
    is_reference_upload = (
        reference_ready
        and source.is_file()
        and file_sha256(source) == file_sha256(REFERENCE_PFD230)
    )
    if not is_reference_upload:
        return {
            "available": False,
            "reason": "Graphe non encore validé pour ce document.",
        }
    return {
        "available": True,
        "label": "Graphe des équipements — PFD-230",
        "note": "Ce graphe Stage 08 est affiché car le PDF téléversé est exactement le PFD-230 validé. Les relations restent de direction inconnue.",
        "equipment_nodes": 16,
        "connections": 8,
        "isolated_equipment": 6,
        "isolated_tags": [e["tag"] for e in load_demo()["equipment"] if not e["connectivity_status"]["connected_to_equipment_graph"]],
        "preview_html": f"/api/analyses/{job['analysis_id']}/reference/pfd230_graph_preview.html",
        "preview_png": f"/api/analyses/{job['analysis_id']}/reference/pfd230_graph_preview.png",
    }


@app.get("/api/analyses/{analysis_id}/results")
def analysis_results(analysis_id: str, user: dict = Depends(require_authenticated_user)):
    """Return only the real OCR/YOLO/tag-association outputs for one job.

    This endpoint intentionally does not manufacture topology, flow direction
    or a structured process graph for generic uploaded documents.
    """

    authorized_analysis(analysis_id, user)
    job = get_job(analysis_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Analysis job not found")
    if job.get("status") != "completed":
        raise HTTPException(status_code=409, detail="Results are available only after the analysis completes")

    root = job_dir(analysis_id)
    manifest = _load_json(root / "stage10_perception_manifest.json", "Perception manifest")
    outputs = manifest.get("outputs", {})
    ocr = _load_json(Path(outputs["ocr_json"]), "OCR")
    yolo = _load_json(Path(outputs["yolo_detections"]), "YOLO")
    associations = _load_json(Path(outputs["associations"]), "Tag association")
    records = associations.get("associations", [])
    status_counts = dict(Counter(str(record.get("status", "unknown")) for record in records))
    return {
        "analysis_id": analysis_id,
        "project_id": pfd_for_analysis(analysis_id)["project_id"],
        "pfd_id": pfd_for_analysis(analysis_id)["id"],
        "ocr": ocr,
        "original_filename": job.get("original_filename"),
        "scope": manifest.get("scope"),
        "not_run": manifest.get("not_run", []),
        "summary": {
            "ocr_texts": ocr.get("detected_text_count", len(ocr.get("items", []))),
            "ocr_mean_confidence": ocr.get("average_confidence"),
            "yolo_detections": yolo.get("inference", {}).get("final_detection_count", 0),
            "class_counts": yolo.get("class_counts", {}),
            "tag_candidates": associations.get("tag_candidate_count", len(records)),
            "association_status_counts": status_counts,
        },
        "detections": yolo.get("detections", []),
        "associations": records,
        "validated_graph": _validated_reference_graph(job),
        "artifacts": {
            "ocr_page": _public_artifact_url(analysis_id, outputs.get("ocr_page")),
            "ocr_json": _public_artifact_url(analysis_id, outputs.get("ocr_json")),
            "yolo_json": _public_artifact_url(analysis_id, outputs.get("yolo_detections")),
            "tag_candidates_json": _public_artifact_url(analysis_id, outputs.get("tag_candidates")),
            "associations_json": _public_artifact_url(analysis_id, outputs.get("associations")),
            "graph_json": _public_artifact_url(analysis_id, outputs.get("graph_json")),
        },
    }


@app.get("/api/analyses/{analysis_id}")
def analysis_status(analysis_id: str, user: dict = Depends(require_authenticated_user)):
    authorized_analysis(analysis_id, user)
    job = get_job(analysis_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Analysis job not found")
    return contextual_job(analysis_id, user)


# Serve the compiled React interface from FastAPI for normal local use.  This
# removes the need for the Vite development server and its hot-reload state.
# API routes above are registered first, so /api/* and /docs remain unchanged.
FRONTEND_DIST = Path(__file__).resolve().parents[2] / "frontend" / "dist"
@app.get("/projects/{route:path}", include_in_schema=False)
@app.get("/projects", include_in_schema=False)
@app.get("/home", include_in_schema=False)
@app.get("/users", include_in_schema=False)
@app.get("/settings", include_in_schema=False)
def workspace_page(route: str = ""):
    return FileResponse(FRONTEND_DIST / "index.html")

if FRONTEND_DIST.is_dir():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIST), html=True), name="frontend")
