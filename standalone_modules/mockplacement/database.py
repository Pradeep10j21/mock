import os
from pymongo import MongoClient
from pymongo.server_api import ServerApi
from dotenv import load_dotenv

# Load env in Case it's not loaded
load_dotenv()

URI = os.getenv("MONGODB_URI")

class Database:
    client: MongoClient = None

    def connect(self):
        if self.client is None:
            self.client = MongoClient(URI, server_api=ServerApi('1'))
            try:
                self.client.admin.command('ping')
                print("Connected to MongoDB!")
            except Exception as e:
                print(e)

    def get_db(self):
        if self.client is None:
            self.connect()
        # You can change the DB name here if needed
        return self.client["mockello_mvp_db"]

db = Database()

def get_database():
    return db.get_db()
