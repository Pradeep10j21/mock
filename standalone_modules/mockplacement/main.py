from fastapi import FastAPI
from dotenv import load_dotenv
import os
from fastapi.middleware.cors import CORSMiddleware
import aptitude_router

load_dotenv()

app = FastAPI(title="Mockello MockPlacement Standalone")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(aptitude_router.router)

@app.get("/")
def root():
    return {"status": "MockPlacement Standalone running"}
