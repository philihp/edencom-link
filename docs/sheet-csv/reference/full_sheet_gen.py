from typing import Dict, List, Optional, Set
import argparse
import yaml
import os

parser = argparse.ArgumentParser()
parser.add_argument("--mode", choices=["twines", "miros"], required=True)
args = parser.parse_args()

SDE_PATH = "sde"

MIN_TYPE_ID = 0

type_filename = (
    os.path.join(SDE_PATH, "types.yaml")
)
blueprint_filename = (
    os.path.join(SDE_PATH, "blueprints.yaml")
)
group_filename = (
    os.path.join(SDE_PATH, "groups.yaml")
)

inputs_csv_filename = "inputs.csv"
outputs_csv_filename = "outputs.csv"
invention_csv_filename = "invention.csv"
types_csv_filename = "types.csv"

with open(blueprint_filename, "r") as f:
    blueprint_data = yaml.load(f, Loader=yaml.CLoader)

def get_output(blueprint_data: dict) -> Optional[int]:
    activities = blueprint_data["activities"]
    if "manufacturing" in activities and "products" in activities["manufacturing"]:
        output = activities["manufacturing"]["products"][0]["typeID"]
    elif "reaction" in activities:
        output = activities["reaction"]["products"][0]["typeID"]
    else:
        output = None
    return output

def remove_duplicate_blueprints(blueprint_data: dict) -> dict:
    """
    When multiple blueprints output the same item, keeps only the blueprint
    with the largest type ID (the most recent one).
    """
    blueprint_ids = sorted(list(blueprint_data.keys()))
    output_blueprints = {}
    return_blueprints = {}
    for id in blueprint_ids:
        output = get_output(blueprint_data[id])
        if output is None:
            return_blueprints[id] = blueprint_data[id]
        else:
            output_blueprints[output] = (id, blueprint_data[id])
    return_blueprints.update(dict(output_blueprints.values()))
    return return_blueprints

blueprint_data = remove_duplicate_blueprints(blueprint_data)

with open(group_filename, "r") as f:
    group_data = yaml.load(f, Loader=yaml.CLoader)

with open(type_filename, "r") as f:
    type_data = yaml.load(f, Loader=yaml.CLoader)

decryptor_types = """Accelerant Decryptor
Attainment Decryptor
Augmentation Decryptor
Parity Decryptor
Process Decryptor
Symmetry Decryptor
Optimized Attainment Decryptor
Optimized Augmentation Decryptor""".split("\n")

name_to_id = {}
id_to_name = {}
for type_id, data in type_data.items():
    if "name" in data and "en" in data["name"]:
        name_to_id[data["name"]["en"]] = type_id
        id_to_name[type_id] = data["name"]["en"]


def insert_industry_lines(entry, input_lines: List[str], output_lines: List[str], types: Set[int], industry_types=None):
    id_to_input_lines: Dict[str, List[str]] = {}
    id_to_output_line: Dict[str, str] = {}
    if "products" in entry and len(entry["products"]) == 1 and "materials" in entry:
        output_id = entry["products"][0]["typeID"]
        output_quantity = entry["products"][0]["quantity"]
        output_name = id_to_name.get(output_id, f"Type {output_id}")
        types.add(output_id)
        if industry_types is not None:
            industry_types.add(output_id)
        type_input_lines = []
        for material_data in entry["materials"]:
            input_id = material_data["typeID"]
            input_name = id_to_name.get(input_id, f"Type {input_id}")
            types.add(input_id)
            input_quantity = material_data["quantity"]
            type_input_lines.append(f'"{output_name}", "{input_name}", "{input_quantity}"')
        id_to_input_lines[output_id] = type_input_lines
        job_time = entry["time"]
        id_to_output_line[output_id] = f'"{output_name}", "{output_quantity}", "{job_time}"'
    # TODO: these dictionary shenanegans currently do nothing, if we really want to dedupe
    # by output ID we need to manipulate a dict with this function
    # and then create input/output lines at the end of the for loop
    for type_id in sorted(list(id_to_output_line.keys())):
        input_lines.extend(id_to_input_lines[type_id])
        output_lines.append(id_to_output_line[output_id])


def insert_invention_lines(entry, blueprint_type_id, invention_lines: List[str], types: Set[int]):
    if len(entry.get("materials", [])) == 2:
        input_1_id = entry["materials"][0]['typeID']
        input_1_quantity = entry["materials"][0]["quantity"]
        input_2_id = entry["materials"][1]['typeID']
        input_2_quantity = entry["materials"][1]["quantity"]
        job_time = entry["time"]
        input_1_name = id_to_name[input_1_id]
        input_2_name = id_to_name[input_2_id]
        types.add(input_1_id)
        types.add(input_2_id)
        types.add(blueprint_type_id)
        blueprint_name = id_to_name[blueprint_type_id]
        for output_data in entry.get("products", []):
            types.add(output_data["typeID"])
            output_name = id_to_name[output_data["typeID"]]
            probability = output_data.get("probability", 1.)
            base_runs = output_data["quantity"]
            invention_lines.append(
                f'"{output_name}", "{blueprint_name}", "{base_runs}", "{input_1_name}", "{input_1_quantity}", '
                f'"{input_2_name}", "{input_2_quantity}", "{job_time}", "{probability}"'
            )


input_lines: List[str] = []
output_lines: List[str] = []
invention_lines: List[str] = []
types: Set[int] = set([name_to_id[n] for n in decryptor_types])
reaction_types: Set[int] = set()
industry_types: Set[int] = set()
# assume blueprints are sorted with newer ones later
for type_id, entry in blueprint_data.items():
    if type_id > MIN_TYPE_ID:
        print(f"processing type {type_id}")
        if "manufacturing" in entry["activities"]:
            insert_industry_lines(entry["activities"]["manufacturing"], input_lines, output_lines, types, industry_types=industry_types)
        if "reaction" in entry["activities"]:
            insert_industry_lines(entry["activities"]["reaction"], input_lines, output_lines, types, industry_types=reaction_types)
        if "invention" in entry["activities"]:
            insert_invention_lines(entry["activities"]["invention"], type_id, invention_lines, types)
    else:
        print(f"skipping type {type_id}")


with open(inputs_csv_filename, "w", encoding="utf-8-sig") as f:
    f.write("\n".join(input_lines))

with open(outputs_csv_filename, "w", encoding="utf-8-sig") as f:
    f.write("\n".join(output_lines))

with open(invention_csv_filename, "w", encoding="utf-8-sig") as f:
    f.write("\n".join(invention_lines))


type_lines = []
for type_id in sorted(list(types)):
    if type_id in type_data:
        data = type_data[type_id]
        type_name = data["name"]["en"]
        volume = data.get("volume", "")
        if type_name == "Outrider Blueprint":
            volume = "0.01"
        if type_id in reaction_types:
            group_name = "Reaction"
        else:
            meta_level = data.get("metaGroupID", None)
            group_id = data.get("groupID", None)
            group_name = "Tech I"
            if args.mode == "miros" and (group_id == 334 or group_id == 873 or group_id == 913):
                group_name = "Component"
            else:
                if meta_level == 1:
                    group_name = "Tech I"
                elif meta_level == 2:
                    group_name = "Tech II"
                elif meta_level == 3:
                    group_name = "Tech III"
                elif meta_level is None:
                    if type_id not in industry_types:
                        group_name = "Input"
                    else:
                        group_name = "Tech I"
        type_lines.append(f'"{type_id}", "{group_name}", "{type_name}", "{volume}"')

with open(types_csv_filename, "w", encoding="utf-8-sig") as f:
    f.write("\n".join(type_lines))


