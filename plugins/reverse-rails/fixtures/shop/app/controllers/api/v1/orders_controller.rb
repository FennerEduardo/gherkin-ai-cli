module Api
  module V1
    class OrdersController < ApplicationController
      before_action :authenticate_user!, except: [:index]

      def index
        render json: Order.all
      end

      def create
        order = Order.create!(order_params.merge(status: 'PENDING'))
        ActiveSupport::Notifications.instrument('order.placed', order: order)
        render json: order, status: :created
      end

      def show
        order = Order.find(params[:id])
        render json: order
      end

      def cancel
        order = Order.find(params[:id])
        if order.status != 'PENDING'
          render json: { error: 'Only pending orders can be cancelled' }, status: :conflict
          return
        end
        order.status = 'CANCELLED'
        order.save!
        render json: order, status: :ok
      end

      private

      def order_params
        params.require(:order).permit(:email, :note)
      end
    end
  end
end
