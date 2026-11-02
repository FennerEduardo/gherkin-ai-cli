from fastapi import FastAPI

from app.routers import orders

app = FastAPI()
app.include_router(orders.router)


@app.get("/health")
def health():
    return {"status": "ok"}
