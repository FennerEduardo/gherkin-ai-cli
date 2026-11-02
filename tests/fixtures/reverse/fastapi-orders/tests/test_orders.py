def test_place_order(client):
    response = client.post("/orders", json={"customer_email": "a@b.co", "items": ["x"], "quantity": 1})
    assert response.status_code == 201
