package com.shop.stock;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestTemplate;

@Entity
class Reservation {
    @Id
    private String id;

    @Column(unique = true)
    private String orderId;

    private String status;

    void setStatus(String status) { this.status = status; }
}

@Component
public class StockListeners {
    private final RestTemplate restTemplate;

    public StockListeners(RestTemplate restTemplate) {
        this.restTemplate = restTemplate;
    }

    @KafkaListener(topics = "orders.order-placed")
    public void reserveStock(OrderPlaced event) {
        Reservation reservation = new Reservation();
        reservation.setStatus("RESERVED");
        restTemplate.postForObject("https://warehouse.example.com/holds", reservation, Void.class);
    }

    @Scheduled(cron = "0 0 * * * *")
    public void releaseExpiredReservations() {
        Reservation reservation = new Reservation();
        reservation.setStatus("RELEASED");
    }
}

record OrderPlaced(String orderId) {}
