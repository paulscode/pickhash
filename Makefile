# Pickhash — build orchestration.
#
# Two StartOS packages are produced from this one repo:
#   * StartOS 0.3.5.1 — manifest.yaml + Deno embassy procedures, packed by `start-sdk`.
#   * StartOS 0.4.0    — startos/ TypeScript SDK tree, packed by `start-cli`.
# Both bake the same Docker image (shared Dockerfile / entrypoint / health checks).
# A third artifact — a multi-arch image on Docker Hub — feeds the plain-Docker and
# Umbrel paths (see the docker-buildx target).
#
# Fast x86_64 smoke build of BOTH StartOS packages -> builds/<version>/:
#   make test-builds
# Full multi-arch (universal) release of BOTH StartOS packages -> builds/<version>/:
#   make release-builds
# Multi-arch Docker Hub image for the Umbrel / plain-Docker path:
#   make docker-buildx           # builds linux/amd64 + linux/arm64 and pushes

# ImageMagick: `convert` works on both v6 and v7; override with MAGICK=magick if preferred.
MAGICK ?= convert
ICON_MASTER := assets/icon-master.png

# -r (raw) is required: this yq (python-yq/jq) otherwise emits JSON-quoted strings
# ("pickhash"), and the quotes leak into make target names and recursive make args.
PKG_ID := $(shell yq -r ".id" manifest.yaml)
PKG_VERSION := $(shell yq -r ".version" manifest.yaml)
BUILD_DIR := builds/$(PKG_VERSION)
# App sources baked into the image; named so make rebuilds the image tar when any change.
APP_FILES := $(shell find app/backend app/frontend -type f -not -path '*/test/*')
IMAGE_DEPS := Dockerfile docker_entrypoint.sh check-web.sh check-mrr.sh tailwind.config.js $(APP_FILES) icon.png

# Empty by default -> both arch image tars build and the 0.3.5.1 package is universal
# (multi-arch). The single-arch convenience targets set ARCH=x86_64|aarch64 to skip one.
ARCH ?=

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
# StartOS 0.3.5.1 package (manifest.yaml + Deno embassy procedures)
# ============================================================================
.PHONY: pack-0351 pack-0351-x86 pack-0351-arm verify-0351

# Bundle the embassy procedures (properties + optional-dependency check) to one JS file.
scripts/embassy.js: scripts/embassy.ts scripts/deps.ts scripts/bundle.ts $(wildcard scripts/procedures/*.ts)
	deno run --allow-read --allow-write --allow-net --allow-env scripts/bundle.ts

# Per-arch runtime image tars consumed by `start-sdk pack`. The ARCH guard lets the
# single-arch targets skip the arch they removed; with ARCH unset (the default) BOTH
# build, and the package `start-sdk pack` emits is multi-arch (universal). The base
# image is a manifest-list digest, so --platform selects the right arch with no build args.
docker-images/x86_64.tar: $(IMAGE_DEPS)
ifneq ($(ARCH),aarch64)
	mkdir -p docker-images
	docker buildx build --tag start9/$(PKG_ID)/main:$(PKG_VERSION) \
	  --platform=linux/amd64 -o type=docker,dest=docker-images/x86_64.tar .
endif

docker-images/aarch64.tar: $(IMAGE_DEPS)
ifneq ($(ARCH),x86_64)
	mkdir -p docker-images
	docker buildx build --tag start9/$(PKG_ID)/main:$(PKG_VERSION) \
	  --platform=linux/arm64 -o type=docker,dest=docker-images/aarch64.tar .
endif

# Universal (multi-arch) 0.3.5.1 package by default. `start-sdk pack` bundles whichever
# arch tars are present in docker-images/, so the single-arch targets rm the other first.
$(PKG_ID).s9pk: manifest.yaml instructions.md icon.png LICENSE scripts/embassy.js docker-images/x86_64.tar docker-images/aarch64.tar
	start-sdk pack

pack-0351: $(PKG_ID).s9pk

# Single-arch 0.3.5.1 packages (dev / targeted testing).
pack-0351-x86:
	@rm -f docker-images/aarch64.tar
	ARCH=x86_64 $(MAKE) pack-0351
pack-0351-arm:
	@rm -f docker-images/x86_64.tar
	ARCH=aarch64 $(MAKE) pack-0351

verify-0351: $(PKG_ID).s9pk
	start-sdk verify s9pk $(PKG_ID).s9pk

# ============================================================================
# StartOS 0.4.0 package (startos/ TypeScript SDK tree)
# ============================================================================
.PHONY: pack-040 pack-040-x86 pack-040-arm verify-040

node_modules: package-lock.json
	npm ci

package-lock.json: package.json
	npm i

# ncc-bundle the startos/ tree to a single JS entrypoint that start-cli evaluates.
javascript/index.js: $(shell find startos -type f 2>/dev/null) tsconfig.json package.json node_modules
	npm run build

# Universal (multi-arch) 0.4.0 package by default. `start-cli s9pk pack` with no --arch
# builds every architecture the manifest declares into one s9pk. start-cli builds the
# Docker image itself (dockerBuild source), cross-building arm64 via buildx/qemu.
$(PKG_ID)_040.s9pk: javascript/index.js manifest.yaml icon-040.png
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
# Combined builds -> builds/<version>/
# ============================================================================
.PHONY: test-builds release-builds clean-builds

# Fast x86_64-only build of BOTH packages (dev smoke test).
test-builds:
	@rm -f docker-images/aarch64.tar $(PKG_ID).s9pk
	ARCH=x86_64 $(MAKE) $(PKG_ID).s9pk javascript/index.js
	rm -rf $(BUILD_DIR)
	mkdir -p $(BUILD_DIR)
	cp $(PKG_ID).s9pk $(BUILD_DIR)/pickhash-0351.s9pk
	start-cli s9pk pack --arch=x86_64 --icon icon-040.png -o $(BUILD_DIR)/pickhash-040.s9pk
	cd $(BUILD_DIR) && sha256sum *.s9pk > SHA256SUMS
	@echo ""
	@echo "Test builds (x86_64):"
	@ls -lh $(BUILD_DIR)/
	@echo ""
	@cat $(BUILD_DIR)/SHA256SUMS

# Full multi-arch (universal) release of BOTH packages -> builds/<version>/. Each s9pk
# carries both linux/amd64 and linux/arm64 images. arm64 cross-builds via buildx/qemu.
release-builds:
	@rm -f $(PKG_ID).s9pk
	$(MAKE) $(PKG_ID).s9pk javascript/index.js
	rm -rf $(BUILD_DIR)
	mkdir -p $(BUILD_DIR)
	cp $(PKG_ID).s9pk $(BUILD_DIR)/pickhash-0351.s9pk
	start-cli s9pk pack --icon icon-040.png -o $(BUILD_DIR)/pickhash-040.s9pk
	cd $(BUILD_DIR) && sha256sum *.s9pk > SHA256SUMS
	@echo ""
	@echo "Release builds (universal / multi-arch):"
	@ls -lh $(BUILD_DIR)/
	@echo ""
	@cat $(BUILD_DIR)/SHA256SUMS

clean-builds:
	rm -f $(PKG_ID).s9pk $(PKG_ID)_040.s9pk $(PKG_ID)_x86_64.s9pk $(PKG_ID)_aarch64.s9pk
	rm -f scripts/embassy.js
	rm -rf docker-images javascript node_modules

# ============================================================================
# Generic multi-arch Docker image (Docker Hub) — the plain-Docker + Umbrel path.
# StartOS builds its own image tars above and does not use these.
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
