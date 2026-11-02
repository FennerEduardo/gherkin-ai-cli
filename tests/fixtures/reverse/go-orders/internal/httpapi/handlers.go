package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"

	"example.com/orders/internal/orders"
	"github.com/go-chi/chi/v5"
)

type PlaceOrderRequest struct {
	CustomerEmail string `json:"customer_email" validate:"required,email"`
	Quantity      int    `json:"quantity" validate:"gt=0"`
}

type OrderHandler struct {
	svc *orders.Service
}

func (h *OrderHandler) PlaceOrder(w http.ResponseWriter, r *http.Request) {
	var req PlaceOrderRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}
	order := h.svc.Place(req.CustomerEmail)
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(order)
}

func (h *OrderHandler) CancelOrder(w http.ResponseWriter, r *http.Request) {
	order, err := h.svc.Cancel(chi.URLParam(r, "id"))
	if errors.Is(err, orders.ErrNotFound) {
		http.Error(w, "order not found", http.StatusNotFound)
		return
	}
	if errors.Is(err, orders.ErrNotPending) {
		http.Error(w, "only pending orders can be cancelled", http.StatusConflict)
		return
	}
	json.NewEncoder(w).Encode(order)
}

func (h *OrderHandler) DispatchShipment(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusAccepted)
}
