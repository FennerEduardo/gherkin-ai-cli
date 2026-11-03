// A Go worker written by hand: a NATS subscription and a cron job.
package main

import (
	"net/http"

	"github.com/nats-io/nats.go"
	"github.com/robfig/cron/v3"
)

type Shipment struct {
	Status string
}

func scheduleShipment(m *nats.Msg) {
	s := Shipment{}
	s.Status = "SCHEDULED"
	http.Post("https://carrier.example.com/pickups", "application/json", nil)
}

func archiveDeliveredShipments() {
	s := Shipment{}
	s.Status = "ARCHIVED"
}

func main() {
	nc, _ := nats.Connect(nats.DefaultURL)
	nc.Subscribe("orders.order-paid", scheduleShipment)
	c := cron.New()
	c.AddFunc("@daily", archiveDeliveredShipments)
	c.Start()
	select {}
}
