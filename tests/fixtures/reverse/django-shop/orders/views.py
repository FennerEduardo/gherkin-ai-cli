from rest_framework import generics, serializers, status, viewsets
from rest_framework.decorators import action, api_view
from rest_framework.exceptions import NotFound, ValidationError
from rest_framework.permissions import IsAdminUser, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView


class OrderSerializer(serializers.ModelSerializer):
    customer_email = serializers.EmailField()
    reference = serializers.CharField(max_length=20)
    note = serializers.CharField(required=False)


class OrderViewSet(viewsets.ModelViewSet):
    serializer_class = OrderSerializer
    permission_classes = (IsAuthenticated,)

    @action(detail=True, methods=["post"])
    def cancel(self, request, pk=None):
        order = self.get_object()
        if order.status != "PENDING":
            return Response({"detail": "Only pending orders can be cancelled"}, status=status.HTTP_409_CONFLICT)
        order.status = "CANCELLED"
        order.save()
        return Response({"status": order.status})


class CustomerListCreateView(generics.ListCreateAPIView):
    permission_classes = (IsAdminUser,)


class VoucherView(APIView):
    def post(self, request, customer_id=None):
        if customer_id is None:
            raise NotFound("Customer not found")
        voucher = {"status": "ISSUED"}
        return Response(voucher, status=status.HTTP_201_CREATED)


@api_view(["GET"])
def health(request):
    return Response({"ok": True})


@api_view(["POST"])
def request_refund(request):
    if not request.data.get("order"):
        raise ValidationError("order is required")
    return Response({"status": "REQUESTED"}, status=status.HTTP_202_ACCEPTED)
