<div align="center">
  <img src="https://via.placeholder.com/150" alt="Lumina AI Logo" width="120" height="120">
  <h1>✦ Lumina AI</h1>
  <p><strong>A modern, full-stack, AI-powered virtual assistant with a premium interface.</strong></p>
</div>

<br/>

## 📖 Project Overview

**What is Lumina?**  
Lumina is a production-ready, AI-powered virtual assistant designed to be more than just a chatbot. It integrates seamless document analysis, memory, and personalized interactions within a highly polished, premium user interface. 

**Why it exists & Problems it solves**  
The AI tooling landscape is often fragmented and lacks cohesive, aesthetically pleasing interfaces. Lumina exists to bridge this gap by offering a portfolio-worthy, open-source template that demonstrates how to build robust, scalable AI SaaS applications. It solves the problem of starting from scratch when building enterprise-grade AI chat platforms.

**Target Users**  
- Developers looking for a modern, scalable full-stack template (Next.js 15 + FastAPI).
- Users who need a secure, private, and localized AI assistant.
- Enterprises wanting an extensible architecture to build custom AI workflows.

**Long-term Vision**  
To evolve into a fully localized ecosystem featuring voice capabilities (Speech-to-Text & Text-to-Speech), Retrieval-Augmented Generation (RAG) with local LLMs (Ollama), and deeply integrated memory for personalized context.

---

## 📸 Screenshots

### Landing Page
*(Screenshot of the beautiful, modern hero section with mock AI interface)*  
![Landing Page](https://via.placeholder.com/800x400?text=Landing+Page+Screenshot)

### Login Page
*(Coming Soon - Phase 4)*

### Dashboard
*(Coming Soon - Phase 5)*

---

## 🛠️ Technology Stack

### Frontend
- **Framework:** Next.js 15 (App Router)
- **Language:** TypeScript
- **Styling:** Tailwind CSS
- **UI Components:** shadcn/ui
- **Animations:** Framer Motion

### Backend
- **Framework:** FastAPI
- **Language:** Python 3.12
- **ORM:** SQLAlchemy 2.0
- **Database:** SQLite
- **Authentication:** JWT (JSON Web Tokens)
- **Security:** bcrypt password hashing
- **Validation:** Pydantic

### Development & DevOps
- **Version Control:** Git & GitHub

---

## 📂 Folder Structure

```text
Lumina/
│
├── backend/                  # FastAPI Application
│   ├── app/
│   │   ├── api/              # Route controllers (auth, health)
│   │   ├── auth/             # Security, JWT, and hashing
│   │   ├── core/             # Configuration and exceptions
│   │   ├── database/         # SQLAlchemy engine and session
│   │   ├── models/           # DB schema definitions
│   │   ├── schemas/          # Pydantic validation schemas
│   │   └── services/         # Business logic layer
│   ├── requirements.txt      # Python dependencies
│   └── lumina.db             # SQLite database (auto-generated)
│
├── frontend/                 # Next.js Application
│   ├── app/                  # App router, globals, and pages
│   ├── components/           # Reusable UI components
│   ├── public/               # Static assets
│   ├── package.json          # Node dependencies
│   └── tailwind.config.ts    # Tailwind CSS configuration
│
├── .gitignore                # Git ignore rules
└── README.md                 # Project documentation
```

---

## 🚀 Setup Instructions

### Backend Setup

1. **Navigate to the backend directory:**
   ```bash
   cd backend
   ```

2. **Create and activate a virtual environment:**
   ```bash
   python -m venv venv
   source venv/bin/activate  # On Windows: venv\Scripts\activate
   ```

3. **Install dependencies:**
   ```bash
   pip install -r requirements.txt
   ```

4. **Configure Environment Variables:**
   Copy the example file and update the variables if necessary.
   ```bash
   cp .env.example .env
   ```

5. **Run the FastAPI server:**
   ```bash
   uvicorn app.main:app --reload
   ```
   *The server will start at `http://127.0.0.1:8000`. The SQLite database (`lumina.db`) will initialize automatically.*

### Frontend Setup

1. **Navigate to the frontend directory:**
   ```bash
   cd frontend
   ```

2. **Install packages:**
   ```bash
   npm install
   ```

3. **Run the Next.js development server:**
   ```bash
   npm run dev
   ```
   *The application will be available at `http://localhost:3000`.*

---

## 🔒 Environment Variables

See `backend/.env.example` for reference:

```env
PROJECT_NAME="Lumina AI"
SECRET_KEY="your-secret-key-here"
ALGORITHM="HS256"
ACCESS_TOKEN_EXPIRE_MINUTES=1440
DATABASE_URL="sqlite:///./lumina.db"
```
*(Ensure you never commit your actual `.env` file to version control).*

---

## 📖 API Documentation Summary

FastAPI automatically generates interactive Swagger documentation. Once the backend is running, visit **`http://127.0.0.1:8000/docs`**.

### Current Endpoints

| Method | Route | Purpose | Auth Required |
|--------|-------|---------|---------------|
| `GET` | `/health` | Check if the API and Database are healthy | ❌ No |
| `POST` | `/auth/register` | Register a new user | ❌ No |
| `POST` | `/auth/login` | Authenticate user and return JWT access token | ❌ No |
| `GET` | `/auth/me` | Get the currently authenticated user's details | ✅ Yes |

**Request/Response Examples:**
- **Register (`POST /auth/register`)**: Expects `{"name": "...", "email": "...", "password": "..."}`. Returns the user object with `id` and timestamps.
- **Login (`POST /auth/login`)**: Compatible with standard OAuth2 Password Flow (Form Data). Returns `{"access_token": "...", "token_type": "bearer"}`.

---

## 🗺️ Future Roadmap

- [x] **Phase 1 – Foundation:** Next.js scaffolding and Tailwind setup.
- [x] **Phase 2 – Landing Page:** Premium, interactive SaaS marketing pages.
- [x] **Phase 2.5 – UI Improvements:** Hero mockups, stats, and professional polish.
- [x] **Phase 3 – Backend Authentication:** FastAPI, SQLite, JWTs, and secure endpoints.
- [x] **Phase 3.5 – Documentation:** Portfolio-ready README and repository polish.
- [ ] **Phase 4 – Frontend Authentication:** Login/Register pages and protected routes.
- [ ] **Phase 5 – Dashboard:** Core user interface and layout.
- [ ] **Phase 6 – AI Integration:** Ollama, Sentence Transformers, and Chat memory.
- [ ] **Phase 7 – Deployment:** Production deployment (Vercel & cloud backend).

---

## 📄 License

This project is open-source and available under the [MIT License](LICENSE).
