from pydantic import BaseModel, EmailStr, Field
from typing import Optional, List, Any, Dict
from datetime import datetime

class UserLogin(BaseModel):
    email: EmailStr
    password: str

class Token(BaseModel):
    access_token: str
    token_type: str

# Mock Placement Result
class MockPlacementResult(BaseModel):
    student_email: str
    student_name: str
    overall_score: float
    created_at: datetime = Field(default_factory=datetime.utcnow)
    details: Dict[str, Any] = {}

class ScoreCreate(BaseModel):
    student_name: str
    student_email: str
    round_type: str
    overall_score: float
    created_at: datetime = Field(default_factory=datetime.utcnow)
    details: dict = {}
