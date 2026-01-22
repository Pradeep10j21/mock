from fastapi import FastAPI
from dotenv import load_dotenv
import os
from fastapi.middleware.cors import CORSMiddleware
import techprep_router

load_dotenv()

app = FastAPI(title="Mockello Tech-Aptitude Standalone")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(techprep_router.router)

@app.get("/")
def root():
    return {"status": "Tech-Aptitude Standalone running"}
