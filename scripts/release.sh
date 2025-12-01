#!/bin/bash

# Copyright 2025 Emmanuel Madehin
# SPDX-License-Identifier: Apache-2.0

# Simple release script for dployr-base
# Usage: ./scripts/release.sh [major|minor|patch] [--beta]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info() { echo -e "${BLUE}[INFO]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }
success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }

# Parse arguments
BUMP_TYPE="${1:-patch}"
IS_BETA=false

if [[ "$2" == "--beta" ]] || [[ "$1" == "--beta" ]]; then
    IS_BETA=true
    if [[ "$1" == "--beta" ]]; then
        BUMP_TYPE="patch"
    fi
fi

# Validate bump type
case "$BUMP_TYPE" in
    major|minor|patch) ;;
    *) error "Invalid bump type: $BUMP_TYPE. Use: major, minor, or patch" ;;
esac

# Get current version from git tags
CURRENT_VERSION=$(git describe --tags --abbrev=0 "$(git rev-list --tags --max-count=1)" 2>/dev/null || echo "v0.0.0")
CURRENT_VERSION=${CURRENT_VERSION#v}  # Remove 'v' prefix

# First release starts with 0.1.0
if [[ "$CURRENT_VERSION" == "0.0.0" ]]; then
    info "No existing tags found. Starting with version 0.1.0"
    CURRENT_VERSION="0.1.0"
    MAJOR=0
    MINOR=1
    PATCH=0
    BETA_NUM=0
    
    if [[ "$IS_BETA" == "true" ]]; then
        NEW_VERSION="v0.1.0-beta.1"
    else
        NEW_VERSION="v0.1.0"
    fi
    
    info "First release version: $NEW_VERSION"
    echo ""
    read -p "Create and push tag $NEW_VERSION? (y/N) " -n 1 -r
    echo ""
    
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        warn "Cancelled"
        exit 0
    fi
    
    # Check if working directory is clean
    if [[ -n $(git status --porcelain) ]]; then
        error "Working directory is not clean. Commit or stash changes first."
    fi
    
    # Create and push tag
    info "Creating first tag $NEW_VERSION..."
    git tag -a "$NEW_VERSION" -m "Initial release $NEW_VERSION"
    
    info "Pushing tag to origin..."
    git push origin "$NEW_VERSION"
    
    success "Tag $NEW_VERSION created and pushed!"
    success "GitHub Actions will now build and release the binaries."
    
    echo ""
    info "Release build at: https://github.com/dployr-io/dployr-base/actions"
    exit 0
fi

# Parse current version
if [[ "$CURRENT_VERSION" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)(-beta\.([0-9]+))?$ ]]; then
    MAJOR=${BASH_REMATCH[1]}
    MINOR=${BASH_REMATCH[2]}
    PATCH=${BASH_REMATCH[3]}
    BETA_NUM=${BASH_REMATCH[5]:-0}
else
    error "Invalid current version format: $CURRENT_VERSION"
fi

info "Current version: v$CURRENT_VERSION"

# Calculate new version
case "$BUMP_TYPE" in
    major)
        MAJOR=$((MAJOR + 1))
        MINOR=0
        PATCH=0
        BETA_NUM=0
        ;;
    minor)
        MINOR=$((MINOR + 1))
        PATCH=0
        BETA_NUM=0
        ;;
    patch)
        if [[ "$CURRENT_VERSION" =~ -beta\. ]]; then
            # If current is beta, just remove beta suffix for release
            if [[ "$IS_BETA" == "true" ]]; then
                BETA_NUM=$((BETA_NUM + 1))
            else
                BETA_NUM=0
            fi
        else
            # Normal patch bump
            if [[ "$IS_BETA" == "true" ]]; then
                PATCH=$((PATCH + 1))
                BETA_NUM=1
            else
                PATCH=$((PATCH + 1))
                BETA_NUM=0
            fi
        fi
        ;;
esac

# Build new version string
if [[ "$IS_BETA" == "true" && "$BETA_NUM" -gt 0 ]]; then
    NEW_VERSION="v${MAJOR}.${MINOR}.${PATCH}-beta.${BETA_NUM}"
else
    NEW_VERSION="v${MAJOR}.${MINOR}.${PATCH}"
fi

info "New version: $NEW_VERSION"

# Confirm with user
echo ""
read -p "Create and push tag $NEW_VERSION? (y/N) " -n 1 -r
echo ""

if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    warn "Cancelled"
    exit 0
fi

# Check if working directory is clean
if [[ -n $(git status --porcelain) ]]; then
    error "Working directory is not clean. Commit or stash changes first."
fi

# If promoting from a beta to a stable release, create an empty commit so the
# stable tag points to a unique commit (avoids ambiguity when multiple tags
# point to the same commit).
if [[ "$CURRENT_VERSION" =~ -beta\. ]] && [[ "$IS_BETA" == "false" ]]; then
    info "Creating empty commit for $NEW_VERSION to ensure unique commit for stable release..."
    git commit --allow-empty -m "Release $NEW_VERSION"
fi

# Create and push tag
info "Creating tag $NEW_VERSION..."
git tag -a "$NEW_VERSION" -m "Release $NEW_VERSION"

info "Pushing tag to origin..."
git push origin "$NEW_VERSION"

success "Tag $NEW_VERSION created and pushed!"
success "GitHub Actions will now build and release the binaries."

echo ""
info "Release build at: https://github.com/dployr-io/dployr-base/actions"