#!/usr/bin/env python3
"""
Face detection script for CutCast face-track render mode.
Analyzes video frames at regular intervals and outputs face positions as JSON.

Usage: python3 detect-faces.py --input video.mp4 --output faces.json --interval 0.5
"""

import argparse
import json
import sys
import cv2
import mediapipe as mp


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

    face_detection = mp.solutions.face_detection.FaceDetection(
        model_selection=1,  # 1 = full range (better for far faces)
        min_detection_confidence=0.5
    )

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
            rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            results = face_detection.process(rgb_frame)

            time_sec = frame_idx / fps
            detection = None

            if results.detections:
                # Pick face with highest confidence
                best = max(results.detections, key=lambda d: d.score[0])
                bbox = best.location_data.relative_bounding_box

                # Convert relative coords to absolute pixels
                x = int(bbox.xmin * width)
                y = int(bbox.ymin * height)
                w = int(bbox.width * width)
                h = int(bbox.height * height)

                # Clamp to frame bounds
                x = max(0, min(x, width - 1))
                y = max(0, min(y, height - 1))
                w = min(w, width - x)
                h = min(h, height - y)

                detection = {
                    "time": round(time_sec, 3),
                    "x": x,
                    "y": y,
                    "w": w,
                    "h": h,
                    "confidence": round(best.score[0], 3)
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
    face_detection.close()

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
