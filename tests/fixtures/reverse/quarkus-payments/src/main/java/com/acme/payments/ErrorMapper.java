package com.acme.payments;

import jakarta.ws.rs.core.Response;
import jakarta.ws.rs.ext.ExceptionMapper;
import jakarta.ws.rs.ext.Provider;

@Provider
public class ErrorMapper implements ExceptionMapper<PaymentStateException> {
    @Override
    public Response toResponse(PaymentStateException e) {
        return Response.status(Response.Status.CONFLICT).entity(e.getMessage()).build();
    }
}
