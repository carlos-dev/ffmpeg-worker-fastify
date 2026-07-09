#!/usr/bin/env python3
"""
Face detection script for CutCast face-track render mode.
Uses OpenCV FaceDetectorYN (DNN-based, works in OpenCV 4.5+ and 5.x).

Usage: python3 detect-faces.py --input video.mp4 --output faces.json --interval 0.5
"""

import argparse
import json
import sys
import os
import urllib.request
import cv2


MODEL_FILENAME = "face_detection_yunet_2023mar.onnx"
MODEL_URL = "https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx"


def get_model_path():
    """Get the YuNet face detection model (bundled in repo)."""
    script_dir = os.path.dirname(os.path.abspath(__file__))
    model_path = os.path.join(script_dir, MODEL_FILENAME)

    if not os.path.exists(model_path):
        print(f"Error: Model not found at {model_path}. It should be bundled in the repo.", file=sys.stderr)
        sys.exit(1)

    return model_path


def detect_faces(input_path: str, output_path: str, interval: float = 0.5, start_time: float = 0, end_time: float = 0):
    cap = cv2.VideoCapture(input_path)
    if not cap.isOpened():
        print(f"Error: Cannot open video {input_path}", file=sys.stderr)
        sys.exit(1)

    fps = cap.get(cv2.CAP_PROP_FPS)
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    duration = total_frames / fps if fps > 0 else 0

    # If start/end provided, only analyze that segment
    start_frame = 0
    end_frame = total_frames
    if start_time > 0:
        start_frame = int(start_time * fps)
        cap.set(cv2.CAP_PROP_POS_FRAMES, start_frame)
    if end_time > 0:
        end_frame = int(end_time * fps)

    segment_duration = (end_frame - start_frame) / fps if fps > 0 else duration
    print(f"Video: {width}x{height} @ {fps:.1f}fps, analyzing {segment_duration:.1f}s (of {duration:.1f}s total)")

    # Initialize YuNet face detector
    model_path = get_model_path()
    detector = cv2.FaceDetectorYN.create(
        model_path,
        "",
        (width, height),
        0.5,   # score threshold
        0.3,   # nms threshold
        5000   # top_k
    )

    detections = []
    frame_interval = int(fps * interval)
    if frame_interval < 1:
        frame_interval = 1

    frame_idx = start_frame
    analyzed = 0

    while frame_idx < end_frame:
        ret, frame = cap.read()
        if not ret:
            break

        if (frame_idx - start_frame) % frame_interval == 0:
            time_sec = frame_idx / fps

            # Detect faces
            _, faces = detector.detect(frame)

            detection = None

            if faces is not None and len(faces) > 0:
                # Pick face with highest confidence (last column is score)
                best_idx = faces[:, -1].argmax()
                face = faces[best_idx]

                x = int(face[0])
                y = int(face[1])
                w = int(face[2])
                h = int(face[3])
                confidence = float(face[-1])

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
                    "confidence": round(confidence, 3)
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
    parser.add_argument('--start', type=float, default=0, help='Start time in seconds')
    parser.add_argument('--end', type=float, default=0, help='End time in seconds')
    args = parser.parse_args()

    detect_faces(args.input, args.output, args.interval, args.start, args.end)
