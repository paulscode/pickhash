# Pickhash — build orchestration.
#
# One StartOS package is produced from this repo: the startos/ TypeScript SDK tree,
# packed by `start-cli` for StartOS 0.4. It is universal: one s9pk carries both an
# x86_64 and an aarch64 image (startos/manifest declares both arches). A second
# artifact — a multi-arch image on Docker Hub — feeds the plain-Docker and Umbrel
# paths (see the docker-buildx target). StartOS 0.3.5 packaging was retired after
# 0.1.5.0.
#
# Fast x86_64 smoke build -> builds/<version>/:
#   make test-builds
# Full universal release -> builds/<version>/:
#   make release-builds
# Multi-arch Docker Hub image for the Umbrel / plain-Docker path:
#   make docker-buildx           # builds linux/amd64 + linux/arm64 and pushes

# ImageMagick: `convert` works on both v6 and v7; override with MAGICK=magick if preferred.
MAGICK ?= convert
ICON_MASTER := assets/icon-master.png

PKG_ID := $(shell sed -n "s/^  id: '\([a-z0-9-]*\)',$$/\1/p" startos/manifest/index.ts)
# The release version is the version graph's `current` entry: v_0_1_5_0 -> 0.1.5.0.
PKG_VERSION := $(shell sed -n 's/^  current: v_\([0-9_]*\),$$/\1/p' startos/versions/index.ts | tr _ .)
# Refuse to run with either unresolved: the build targets `rm -rf $(BUILD_DIR)`, and an
# empty version would make that the whole builds/ folder of signed releases.
ifeq ($(PKG_ID),)
$(error could not read the package id from startos/manifest/index.ts)
endif
ifeq ($(shell echo '$(PKG_VERSION)' | grep -Ex '[0-9]+(\.[0-9]+){3}'),)
$(error could not read the current version from startos/versions/index.ts (got "$(PKG_VERSION)"))
endif
BUILD_DIR := builds/$(PKG_VERSION)
# Everything start-cli bakes into the image, so `make pack-040` repacks when any of it changes.
IMAGE_DEPS := Dockerfile docker_entrypoint.sh check-web.sh tailwind.config.js icon.png \
  $(shell find app/backend app/frontend -type f -not -path '*/test/*')

.DELETE_ON_ERROR:

.PHONY: css
# Compile the dashboard stylesheet into app/frontend/ for the live-reload dev setup
# (docker-compose.override.yml mounts it). Re-run after changing Tailwind classes.
# The image build compiles its own copy — this is dev-only (gitignored).
css:
	docker run --rm -v "$(CURDIR)":/b -w /b node:24-slim \
	  sh -c "npm install -g tailwindcss@3.4.17 >/dev/null 2>&1 && npx tailwindcss -i app/frontend/src/input.css -o app/frontend/dashboard.min.css --minify"
	@echo "wrote app/frontend/dashboard.min.css"

.PHONY: icons
# Regenerate all committed icon artifacts from the master. Run only when the master
# changes, then commit the outputs — builds/pack consume the committed files and must
# never need ImageMagick. The 0.4.0 icon MUST stay <= 40960 bytes at 192x192.
icons: $(ICON_MASTER)
	$(MAGICK) $(ICON_MASTER) -resize 192x192 icon.png
	$(MAGICK) $(ICON_MASTER) -resize 192x192 -strip -colors 128 -define png:compression-level=9 icon-040.png
	@sz=$$(stat -c '%s' icon-040.png); echo "icon-040.png = $$sz bytes (limit 40960)"; \
	 if [ "$$sz" -gt 40960 ]; then \
	   echo "  -> over limit, retrying at 64 colors"; \
	   $(MAGICK) $(ICON_MASTER) -resize 192x192 -strip -colors 64 -define png:compression-level=9 icon-040.png; \
	   sz=$$(stat -c '%s' icon-040.png); echo "  icon-040.png = $$sz bytes"; \
	   [ "$$sz" -le 40960 ] || { echo "ERROR: icon-040.png still over 40960 bytes"; exit 1; }; \
	 fi
	$(MAGICK) $(ICON_MASTER) -resize 480x480 logo.png
	$(MAGICK) $(ICON_MASTER) -resize 256x256 -strip /tmp/pickhash-icon-256.png
	@printf '%s' '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="256" height="256" viewBox="0 0 256 256">' > icon.svg
	@printf '\n  <image width="256" height="256" xlink:href="data:image/png;base64,' >> icon.svg
	@base64 -w0 /tmp/pickhash-icon-256.png >> icon.svg
	@printf '"/>\n</svg>\n' >> icon.svg
	@echo "icons regenerated: icon.png icon-040.png logo.png icon.svg"

# ============================================================================
# StartOS 0.4.0 package (startos/ TypeScript SDK tree)
# ============================================================================
.PHONY: pack-040 pack-040-x86 pack-040-arm verify-040

node_modules: package-lock.json
	npm ci

package-lock.json: package.json
	npm i

# ncc-bundle the startos/ tree to a single JS entrypoint that start-cli evaluates, behind
# the same gate as the SDK's s9pk.mk (which this Makefile does not include): type check,
# the SDK's lint rules and a prettier check. The SDK supplies typescript, prettier and ncc.
SDK_DIR := node_modules/@start9labs/start-sdk
PRETTIER_CONFIG := $(SDK_DIR)/prettier.config.json

javascript/index.js: $(shell find startos -type f 2>/dev/null) tsconfig.json package.json node_modules
	npx tsc --noEmit
	node $(SDK_DIR)/lint.mjs
	npx prettier --config $(PRETTIER_CONFIG) --check startos
	rm -rf javascript && npx ncc build startos/index.ts -o javascript

.PHONY: format
format: | node_modules
	npx prettier --config $(PRETTIER_CONFIG) --write startos

# Universal (multi-arch) 0.4.0 package by default. `start-cli s9pk pack` with no --arch
# builds every architecture the manifest declares into one s9pk. start-cli builds the
# Docker image itself (dockerBuild source), cross-building arm64 via buildx/qemu.
$(PKG_ID)_040.s9pk: javascript/index.js icon-040.png $(IMAGE_DEPS)
	start-cli s9pk pack --icon icon-040.png -o $(PKG_ID)_040.s9pk

pack-040: $(PKG_ID)_040.s9pk

# Single-arch 0.4.0 packages (dev / targeted testing).
pack-040-x86: javascript/index.js
	start-cli s9pk pack --arch=x86_64 --icon icon-040.png -o $(PKG_ID)_x86_64.s9pk
pack-040-arm: javascript/index.js
	start-cli s9pk pack --arch=aarch64 --icon icon-040.png -o $(PKG_ID)_aarch64.s9pk

verify-040: $(PKG_ID)_040.s9pk
	start-cli s9pk inspect $(PKG_ID)_040.s9pk manifest >/dev/null && echo "0.4.0 s9pk OK"

# ============================================================================
# Builds -> builds/<version>/
# ============================================================================
.PHONY: test-builds release-builds clean-builds

# Fast x86_64-only build (dev smoke test).
test-builds: javascript/index.js
	rm -rf $(BUILD_DIR)
	mkdir -p $(BUILD_DIR)
	start-cli s9pk pack --arch=x86_64 --icon icon-040.png -o $(BUILD_DIR)/pickhash-040.s9pk
	cd $(BUILD_DIR) && sha256sum *.s9pk > SHA256SUMS
	@echo ""
	@echo "Test build (x86_64):"
	@ls -lh $(BUILD_DIR)/
	@echo ""
	@cat $(BUILD_DIR)/SHA256SUMS

# Full universal release: one s9pk carrying both the linux/amd64 and linux/arm64 images.
# arm64 cross-builds via buildx/qemu.
release-builds: javascript/index.js
	rm -rf $(BUILD_DIR)
	mkdir -p $(BUILD_DIR)
	start-cli s9pk pack --icon icon-040.png -o $(BUILD_DIR)/pickhash-040.s9pk
	cd $(BUILD_DIR) && sha256sum *.s9pk > SHA256SUMS
	@echo ""
	@echo "Release build (universal / multi-arch):"
	@ls -lh $(BUILD_DIR)/
	@echo ""
	@cat $(BUILD_DIR)/SHA256SUMS

clean-builds:
	rm -f $(PKG_ID)_040.s9pk $(PKG_ID)_x86_64.s9pk $(PKG_ID)_aarch64.s9pk
	rm -rf javascript node_modules

# ============================================================================
# Generic multi-arch Docker image (Docker Hub) — the plain-Docker + Umbrel path.
# StartOS packs build their own images and do not use these.
# ============================================================================
.PHONY: docker-build-local docker-buildx
DOCKER_REPO ?= paulscode/pickhash
DOCKER_TAG  ?= $(PKG_VERSION)

# Single-arch local build for testing (no push). Tags :<version> and :latest.
docker-build-local:
	docker build -t $(DOCKER_REPO):$(DOCKER_TAG) -t $(DOCKER_REPO):latest .

# Multi-arch build + push to Docker Hub (Umbrel consumes this). One-time setup:
#   docker login   &&   docker buildx create --use --name pickhash-builder
docker-buildx:
	docker buildx build --platform linux/amd64,linux/arm64 \
	  -t $(DOCKER_REPO):$(DOCKER_TAG) -t $(DOCKER_REPO):latest --push .
