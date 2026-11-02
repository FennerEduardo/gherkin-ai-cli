package com.acme.billing

class InvoiceControllerTest {
    @Test
    fun paysAnOpenInvoice() {
        mockMvc.perform(post("/api/invoices/{id}/pay", "INV-1")).andExpect(status().isOk)
    }
}
