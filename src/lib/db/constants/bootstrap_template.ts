import { WORKFLOW_NAME } from "./constants";

export const BOOTSTRAP_TEMPLATE = `name: ${WORKFLOW_NAME}

on:
  workflow_dispatch:
    inputs:
      id:
        description: 'Deployment ID'
        required: true
      token:
        description: 'Bootstrap token'
        required: true
      config:
        description: 'Instance configuration'
        required: false

jobs:
  bootstrap:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout code
        uses: actions/checkout@v4
      
      - name: Bootstrap deployment
        run: |
          echo "Bootstrapping deployment with ID: \${{ github.event.inputs.deployment_id }}"
          # TODO: Add deployment logic here`;