# Industrial PFD Analysis — PFD Intelligence

Application web d'analyse assistée des **Process Flow Diagrams (PFD)**. Elle
combine une API FastAPI, une interface React/TypeScript et un pipeline local de
perception documentaire fondé sur PaddleOCR et YOLO.

## Fonctionnalités présentes dans le code

- authentification et contrôle d'accès via Supabase ;
- gestion des utilisateurs et des projets ;
- import de PFD au format PDF ;
- exécution isolée des analyses ;
- OCR et extraction des tags d'équipements ;
- détection d'équipements avec YOLO ;
- association spatiale entre textes OCR et détections ;
- construction prudente d'un graphe de connectivité ;
- visualisation des résultats dans une interface React.

## Architecture

```text
.
├── scripts/             # Pipeline OCR, YOLO, association et graphe
└── webapp/
    ├── backend/         # API FastAPI
    └── frontend/        # React, TypeScript et Vite
```

## Données exclues du dépôt

Ce dépôt ne contient volontairement aucun document industriel JESA, dataset,
résultat d'analyse, base locale, secret, environnement virtuel ou poids de
modèle entraîné. Ces éléments doivent rester dans un stockage privé autorisé.

Le pipeline YOLO attend par défaut le fichier local suivant :

```text
artifacts/jesa_yolo11s_v3s/weights/best_v3.pt
```

Ce fichier est ignoré par Git. Ne le publiez pas sans autorisation explicite.

## Configuration

### Backend

Prérequis : Python 3.11 ou version compatible.

```powershell
cd webapp/backend
py -3.11 -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item .env.example .env
uvicorn app.main:app --reload
```

Configurer `webapp/backend/.env` avec les paramètres publics Supabase. Ne jamais
y placer une clé `service_role`, un mot de passe de base de données ou un autre
secret destiné à être versionné.

### Frontend

Prérequis : Node.js 20 ou version compatible.

```powershell
cd webapp/frontend
npm install
npm run dev
```

L'interface est disponible sur `http://localhost:5173` et l'API sur
`http://localhost:8000`.

## Limites actuelles

- Le traitement générique est validé pour des PFD d'une page.
- Les poids YOLO et les jeux de données ne sont pas distribués dans ce dépôt.
- Les résultats historiques et la démonstration PFD-230 sont exclus pour
  protéger les données industrielles.
- Les relations et directions non confirmées doivent rester signalées comme
  nécessitant une validation métier.

## Sécurité et confidentialité

Avant tout commit, vérifier que les fichiers `.env`, les PDF, les exports, les
poids de modèles et les données industrielles ne sont pas suivis par Git. Le
dépôt est destiné à rester **privé** tant qu'une publication n'a pas reçu les
autorisations nécessaires.
