package com.acme.billing

import jakarta.validation.constraints.Email
import jakarta.validation.constraints.NotBlank
import jakarta.validation.constraints.Positive
import org.springframework.http.HttpStatus
import org.springframework.web.bind.annotation.ResponseStatus

enum class InvoiceStatus { OPEN, PAID }

data class Invoice(val id: String, val customerEmail: String, val amount: Long, var status: InvoiceStatus)

data class IssueInvoiceRequest(
    @field:NotBlank val number: String,
    @field:Email val customerEmail: String,
    @field:Positive val amount: Long
)

data class InvoicePaidEvent(val invoiceId: String)

@ResponseStatus(HttpStatus.NOT_FOUND)
class InvoiceNotFoundException(message: String) : RuntimeException(message)

@ResponseStatus(HttpStatus.CONFLICT)
class InvoiceAlreadyPaidException(message: String) : RuntimeException(message)

interface InvoiceRepository {
    fun findById(id: String): Invoice?
    fun save(invoice: Invoice): Invoice
}
