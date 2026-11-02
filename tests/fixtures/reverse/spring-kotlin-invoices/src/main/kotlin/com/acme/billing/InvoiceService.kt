package com.acme.billing

import org.springframework.context.ApplicationEventPublisher
import org.springframework.stereotype.Service

@Service
class InvoiceService(private val repository: InvoiceRepository, private val publisher: ApplicationEventPublisher) {

    fun issue(request: IssueInvoiceRequest): Invoice {
        val invoice = Invoice(id = request.number, customerEmail = request.customerEmail, amount = request.amount, status = InvoiceStatus.OPEN)
        return repository.save(invoice)
    }

    fun pay(id: String): Invoice {
        val invoice = repository.findById(id) ?: throw InvoiceNotFoundException("Invoice not found")
        if (invoice.status != InvoiceStatus.OPEN) throw InvoiceAlreadyPaidException("Only open invoices can be paid")
        invoice.status = InvoiceStatus.PAID
        repository.save(invoice)
        publisher.publishEvent(InvoicePaidEvent(id))
        return invoice
    }

    fun find(id: String): Invoice = repository.findById(id) ?: throw InvoiceNotFoundException("Invoice not found")
}
