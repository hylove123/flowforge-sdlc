IMAGE_NAME := flowforge-sdlc
COMPOSE := docker-compose

.PHONY: build up down logs deploy clean

build:
	docker build -t $(IMAGE_NAME):latest .

up:
	$(COMPOSE) up -d

down:
	$(COMPOSE) down

logs:
	$(COMPOSE) logs -f

deploy: build up

clean:
	$(COMPOSE) down --rmi all --volumes --remove-orphans
	docker rmi $(IMAGE_NAME):latest 2>/dev/null || true
