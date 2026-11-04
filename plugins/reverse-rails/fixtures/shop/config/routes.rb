Rails.application.routes.draw do
  namespace :api do
    namespace :v1 do
      resources :orders, only: [:index, :create, :show] do
        member do
          post :cancel
        end
        resources :comments, only: [:create]
      end
      resource :profile, only: [:show, :update]
      get 'tags', to: 'tags#index'
    end
  end
end
