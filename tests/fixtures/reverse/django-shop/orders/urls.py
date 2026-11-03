from django.urls import include, path, re_path
from rest_framework.routers import DefaultRouter

from . import views

router = DefaultRouter()
router.register(r"orders", views.OrderViewSet)

urlpatterns = [
    path("", include(router.urls)),
    path("customers/", views.CustomerListCreateView.as_view()),
    re_path(r"^customers/(?P<customer_id>\d+)/vouchers/?$", views.VoucherView.as_view()),
    path("health/", views.health),
    path("refunds/", views.request_refund),
]
