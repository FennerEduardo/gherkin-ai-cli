# Celery worker of a FastAPI shop, written by hand.
import requests
from celery import shared_task


class Receipt:
    def __init__(self):
        self.status = "PENDING"


@shared_task(name="receipts.send")
def send_receipt(order_id: str):
    receipt = Receipt()
    requests.post("https://mail.example.com/send", json={"order": order_id})
    receipt.status = "SENT"
    return receipt
