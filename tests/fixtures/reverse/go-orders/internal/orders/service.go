package orders

import "errors"

var ErrNotFound = errors.New("order not found")
var ErrNotPending = errors.New("order is not pending")

type Order struct {
	ID     string
	Status string
}

type Publisher interface{ Publish(name string, payload any) }

type Service struct {
	store map[string]*Order
	bus   Publisher
}

func (s *Service) Place(email string) *Order {
	o := &Order{ID: email, Status: "PENDING"}
	s.store[o.ID] = o
	s.bus.Publish("OrderPlaced", o)
	return o
}

func (s *Service) Cancel(id string) (*Order, error) {
	o, ok := s.store[id]
	if !ok {
		return nil, ErrNotFound
	}
	if o.Status != "PENDING" {
		return nil, ErrNotPending
	}
	o.Status = "CANCELLED"
	return o, nil
}
