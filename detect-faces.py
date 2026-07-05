#!/usr/bin/env python3
"""
Face detection script for CutCast face-track render mode.
Uses OpenCV Haar Cascade (built into opencv-python-headless, no extra dependencies).

Usage: python3 detect-faces.py --input video.mp4 --output faces.json --interval 0.5
"""

import argparse
import json
import sys
import cv2
import os


def detect_faces(input_path: str, output_path: str, interval: float = 0.5):
    cap = cv2.VideoCapture(input_path)
    if not cap.isOpened():
        print(f"Error: Cannot open video {input_path}", file=sys.stderr)
        sys.exit(1)

    fps = cap.get(cv2.CAP_PROP_FPS)
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    duration = total_frames / fps if fps > 0 else 0

    print(f"Video: {width}x{height} @ {fps:.1f}fps, {duration:.1f}s, {total_frames} frames")

    # Use OpenCV's built-in Haar Cascade for face detection
    cascade_path = cv2.data.haarcascades + 'haarcascade_frontalface_default.xml'
    if not os.path.exists(cascade_path):
        print(f"Error: Haar cascade not found at {cascade_path}", file=sys.stderr)
        sys.exit(1)

    face_cascade = cv2.CascadeClassifier(cascade_path)

    detections = []
    frame_interval = int(fps * interval)
    if frame_interval < 1:
        frame_interval = 1

    frame_idx = 0
    analyzed = 0

    while True:
        ret, frame = cap.read()
        if not ret:
            break

        if frame_idx % frame_interval == 0:
            time_sec = frame_idx / fps

            # Convert to grayscale for Haar cascade
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)

            # Detect faces
            faces = face_cascade.detectMultiScale(
                gray,
                scaleFactor=1.1,
                minNeighbors=5,
                minSize=(int(width * 0.05), int(height * 0.05))  # Min face size: 5% of frame
            )

            detection = None

            if len(faces) > 0:
                # Pick the largest face (most likely the main subject)
                largest = max(faces, key=lambda f: f[2] * f[3])
                x, y, w, h = largest

                detection = {
                    "time": round(time_sec, 3),
                    "x": int(x),
                    "y": int(y),
                    "w": int(w),
                    "h": int(h),
                    "confidence": 0.9
                }
            else:
                detection = {
                    "time": round(time_sec, 3),
                    "x": None,
                    "y": None,
                    "w": None,
                    "h": None,
                    "confidence": 0
                }

            detections.append(detection)
            analyzed += 1

        frame_idx += 1

    cap.release()

    output = {
        "fps": fps,
        "width": width,
        "height": height,
        "duration": round(duration, 3),
        "detections": detections
    }

    with open(output_path, 'w') as f:
        json.dump(output, f)

    detected_count = sum(1 for d in detections if d["x"] is not None)
    print(f"Analyzed {analyzed} frames, detected faces in {detected_count}/{analyzed}")


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Detect faces in video')
    parser.add_argument('--input', required=True, help='Input video path')
    parser.add_argument('--output', required=True, help='Output JSON path')
    parser.add_argument('--interval', type=float, default=0.5, help='Analysis interval in seconds')
    args = parser.parse_args()

    detect_faces(args.input, args.output, args.interval)
