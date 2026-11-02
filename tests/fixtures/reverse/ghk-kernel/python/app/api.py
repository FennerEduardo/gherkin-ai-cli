from fastapi import FastAPI

app = FastAPI()


# ghk:implements Invoice
@app.post("/api/v1/invoice/{aggregate_id}/{command}")
def execute_invoice(aggregate_id: str, command: str):
    """POST /api/v1/invoice/{id}/{command} (pay_invoice)."""
    return {"status": "created"}
