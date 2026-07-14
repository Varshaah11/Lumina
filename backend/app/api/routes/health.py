from fastapi import APIRouter
from app.database.database import engine
from sqlalchemy import text

router = APIRouter()

@router.get("/")
def read_root():
    return {"message": "Welcome to Lumina AI Backend"}

@router.get("/health")
def check_health():
    db_status = "unhealthy"
    try:
        with engine.connect() as connection:
            connection.execute(text("SELECT 1"))
            db_status = "healthy"
    except Exception:
        pass
        
    return {
        "status": "healthy", 
        "database": db_status
    }
