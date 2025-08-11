#!/bin/bash

echo "Starting Ollama server..."

ollama serve &
SERVER_PID=$!

sleep 5

echo "🔍 Checking for LLaMA 2 model..."
if ! ollama list | grep -q "llama2:7b-chat"; then
    echo "Pulling model..."
    ollama pull llama2:7b-chat
    echo "Model ready"
else
    echo "Model already available"
fi

echo "Ollama server ready at http://localhost:11434"

wait $SERVER_PID
